import { getPool } from '../db/index.js';
import { backupDb, restoreDb } from '../db/backup.js';
import { getS3Service } from './s3-storage.js';
import { BackupService } from './backup-service.js';
import { memoryLogger } from './logger.js';
import { hotConfigCache } from './hot-config-cache.js';
import { runtimeSystemConfigCache } from './runtime-system-config-cache.js';
import { reasoningEffortSuffixesCache } from './reasoning-effort-suffixes.js';
import { antiBotService } from './anti-bot.js';
import { requestHeaderForwardingService } from './request-header-forwarding.js';
import { upstreamSslConfigService } from './upstream-ssl-config.js';
import type { RestoreOptions, RestoreRecord } from '../types/index.js';
import type { PoolConnection } from 'mysql2/promise';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import * as tar from 'tar';

// 与 BackupService 的 BACKUP_TABLES/LOG_TABLES 保持一致（后者未导出）。
// 索引文件来自备份归档内容，表名会被拼进 SQL 标识符，
// 因此在任何写操作之前先用该白名单校验。
const RESTORABLE_TABLES = new Set([
  'users',
  'providers',
  'models',
  'virtual_keys',
  'system_config',
  'routing_configs',
  'expert_routing_configs',
  'api_requests',
  'expert_routing_logs',
  'health_runs',
  'health_summaries',
  'prompt_samples',
]);

const LOG_TABLES = new Set([
  'api_requests',
  'expert_routing_logs',
  'health_runs',
  'health_summaries',
  'prompt_samples',
]);

interface RestoreTableData {
  table: string;
  columns: string[];
  rows: any[];
}

export class RestoreService {
  private tempDir: string;
  private backupService: BackupService;

  constructor() {
    this.tempDir = process.env.BACKUP_TEMP_DIR || join(process.cwd(), 'temp', 'backups');
    this.backupService = new BackupService();
  }

  async restoreFromBackup(
    backupId: string,
    options: RestoreOptions = {}
  ): Promise<RestoreRecord> {
    const restoreId = `restore_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const timestamp = Date.now();
    const restoreType = options.restore_type === 'partial' ? 'partial' : 'full';

    // 临时产物路径：无论恢复成败都要在 finally 中清理，且清理失败不得掩盖恢复结果。
    const extractDir = join(this.tempDir, 'extract');
    const encryptedPath = join(this.tempDir, `${backupId}.tar.gz.enc`);
    const tarPath = join(this.tempDir, `${backupId}.tar.gz`);
    let downloaded = false;

    try {
      const backupRecord = await backupDb.getBackupRecord(backupId);
      if (!backupRecord) {
        throw new Error(`Backup not found: ${backupId}`);
      }

      if (backupRecord.status !== 'completed') {
        throw new Error(`Backup is not completed: ${backupId}`);
      }

      let backupBeforeRestore: string | null = null;
      if (options.create_backup_before_restore) {
        memoryLogger.info('Creating safety backup before restore', 'Restore');
        const safetyBackup = await this.backupService.createFullBackup({
          backup_type: 'full',
          includes_logs: false
        });
        backupBeforeRestore = safetyBackup.id;
      }

      await restoreDb.createRestoreRecord({
        id: restoreId,
        backup_record_id: backupId,
        restore_type: restoreType,
        status: 'running',
        started_at: timestamp,
        completed_at: null,
        error_message: null,
        backup_before_restore: backupBeforeRestore,
        changes_made: null,
        rollback_data: null
      });

      memoryLogger.info(`Starting restore: ${restoreId} from backup ${backupId}`, 'Restore');

      // Download backup from S3
      mkdirSync(this.tempDir, { recursive: true });
      const s3Service = getS3Service();
      await s3Service.downloadFile(backupRecord.s3_key, encryptedPath);
      downloaded = true;

      // Decrypt backup
      await this.backupService.decryptFile(encryptedPath, tarPath);

      // Extract tar.gz
      mkdirSync(extractDir, { recursive: true });
      await tar.extract({
        file: tarPath,
        cwd: extractDir
      });

      const fs = await import('fs/promises');
      const dirs = await fs.readdir(extractDir);
      if (dirs.length !== 1) {
        throw new Error(`Invalid backup archive: expected exactly one top-level directory, found ${dirs.length}`);
      }
      const backupDir = join(extractDir, dirs[0]);

      // Read metadata and verify
      const metadataPath = join(backupDir, 'metadata.json');
      let metadata: any;
      try {
        metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
      } catch (error: any) {
        throw new Error(`Invalid backup metadata.json: ${error.message}`);
      }
      memoryLogger.info(`Backup ${backupId} metadata: type=${metadata?.backup_type}, version=${metadata?.version}`, 'Restore');

      if (options.verify_data) {
        memoryLogger.info('Verifying backup integrity', 'Restore');
        const checksumPath = join(backupDir, 'checksum.md5');
        await fs.readFile(checksumPath, 'utf-8');
        // Note: Full checksum verification would require recalculating
      }

      // Read index
      const indexPath = join(backupDir, 'index.json');
      let index: { tables: string[] };
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
      } catch (error: any) {
        throw new Error(`Invalid backup index.json: ${error.message}`);
      }
      if (!Array.isArray(index.tables)) {
        throw new Error('Invalid backup index.json: tables must be an array');
      }

      // Determine which tables to restore.
      // 在任何破坏性写入之前完成校验，缺失/非法的备份数据不允许清空表。
      let tablesToRestore = index.tables;
      if (restoreType === 'partial') {
        if (!options.tables_to_restore || options.tables_to_restore.length === 0) {
          throw new Error('Partial restore requires a non-empty tables_to_restore list');
        }
        const requested = options.tables_to_restore;
        const missing = requested.filter(table => !index.tables.includes(table));
        if (missing.length > 0) {
          throw new Error(`Tables not present in backup ${backupId}: ${missing.join(', ')} (available: ${index.tables.join(', ')})`);
        }
        tablesToRestore = index.tables.filter(table => requested.includes(table));
        memoryLogger.info(`Partial restore: restoring ${tablesToRestore.length} tables`, 'Restore');
      }

      // 在开始任何数据库写入前读取并校验全部恢复数据，
      // 确保后续事务阶段不会因为可提前发现的备份缺陷而中途回滚/半恢复。
      const tableData = await this.loadRestoreData(backupDir, tablesToRestore);

      const changesMade = await this.runTransactionalRestore(restoreType, tableData);

      await restoreDb.updateRestoreRecord(restoreId, {
        status: 'completed',
        completed_at: Date.now(),
        changes_made: JSON.stringify(changesMade)
      });

      // 提交成功后让运行时缓存与数据库收敛。各 reload 自带兜底，
      // 这里整体也做保护，避免缓存刷新问题把已成功的恢复误报为失败。
      await this.reloadRuntimeCaches();

      memoryLogger.info(`Restore completed: ${restoreId}`, 'Restore');

      return await restoreDb.getRestoreRecord(restoreId) as RestoreRecord;
    } catch (error: any) {
      const message = error?.message || String(error);
      memoryLogger.error(`Restore failed: ${message}`, 'Restore');

      // 事务已在 runTransactionalRestore 内回滚；这里在回滚之后才落失败状态。
      try {
        await restoreDb.updateRestoreRecord(restoreId, {
          status: 'failed',
          completed_at: Date.now(),
          error_message: message
        });
      } catch (recordError: any) {
        memoryLogger.error(`Failed to mark restore ${restoreId} as failed: ${recordError?.message || recordError}`, 'Restore');
      }

      throw error;
    } finally {
      // 清理临时文件不得掩盖恢复的成功/失败结果。
      if (downloaded) {
        this.cleanupTempArtifacts(extractDir, encryptedPath, tarPath);
      }
    }
  }

  /**
   * 读取并校验备份中所有待恢复表的数据。
   * 任何缺失文件、非法 JSON、非数组数据、行结构不一致或白名单外的表名
   * 都会在数据库写入开始之前抛出错误。
   */
  private async loadRestoreData(
    backupDir: string,
    tables: string[]
  ): Promise<RestoreTableData[]> {
    const fs = await import('fs/promises');
    const result: RestoreTableData[] = [];

    for (const table of tables) {
      if (!RESTORABLE_TABLES.has(table)) {
        throw new Error(`Unsupported table in backup index: ${table}`);
      }

      const isLogTable = LOG_TABLES.has(table);
      const dataPath = join(backupDir, isLogTable ? 'logs' : 'data', `${table}.json`);

      let raw: string;
      try {
        raw = await fs.readFile(dataPath, 'utf-8');
      } catch (error: any) {
        throw new Error(`Backup data file missing for table ${table}: ${dataPath} (${error.message})`);
      }

      let data: any;
      try {
        data = JSON.parse(raw);
      } catch (error: any) {
        throw new Error(`Invalid JSON in backup data file for table ${table}: ${error.message}`);
      }

      if (!Array.isArray(data)) {
        throw new Error(`Invalid backup data for table ${table}: expected an array of rows`);
      }

      const columns = data.length > 0 ? Object.keys(data[0]) : [];
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error(`Invalid row at index ${i} in backup data for table ${table}`);
        }
        const rowColumns = Object.keys(row);
        if (rowColumns.length !== columns.length || columns.some(col => !(col in row))) {
          throw new Error(`Inconsistent columns in backup data for table ${table} at row ${i}: expected [${columns.join(', ')}], got [${rowColumns.join(', ')}]`);
        }
      }

      result.push({ table, columns, rows: data });
    }

    return result;
  }

  /**
   * 在单个连接的单个事务内执行全部 DELETE/INSERT。
   * 任一语句失败即回滚全部网关表的变更，回滚完成后才向外抛出错误。
   */
  private async runTransactionalRestore(
    restoreType: 'full' | 'partial',
    tableData: RestoreTableData[]
  ): Promise<Record<string, number>> {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const changesMade: Record<string, number> = {};
      for (const { table, columns, rows } of tableData) {
        if (restoreType === 'full') {
          await connection.query(`DELETE FROM \`${table}\``);
        }

        if (rows.length > 0) {
          // Partial restore 统一使用 upsert 语义（与备份元数据无关），
          // 避免目标库已有同主键行时报 duplicate key。
          if (restoreType === 'partial') {
            await this.upsertData(connection, table, rows, columns);
          } else {
            await this.insertData(connection, table, rows, columns);
          }
        }

        changesMade[table] = rows.length;
        memoryLogger.info(`Restored ${rows.length} records to ${table}`, 'Restore');
      }

      await connection.commit();
      return changesMade;
    } catch (error) {
      // 回滚失败不得掩盖原始错误。
      try {
        await connection.rollback();
      } catch (rollbackError: any) {
        memoryLogger.error(`Rollback failed for restore transaction: ${rollbackError?.message || rollbackError}`, 'Restore');
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async insertData(
    connection: PoolConnection,
    tableName: string,
    data: any[],
    columns: string[]
  ): Promise<void> {
    const placeholders = columns.map(() => '?').join(', ');
    const insertQuery = `INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;

    for (const row of data) {
      const values = columns.map(col => row[col]);
      await connection.query(insertQuery, values);
    }
  }

  private async upsertData(
    connection: PoolConnection,
    tableName: string,
    data: any[],
    columns: string[]
  ): Promise<void> {
    // 只有主键列时无法生成 UPDATE 子句，退化为 INSERT IGNORE 以维持幂等。
    const updateClauses = columns.filter(col => col !== 'id').map(col => `\`${col}\` = VALUES(\`${col}\`)`);
    const placeholders = columns.map(() => '?').join(', ');

    let query = `INSERT ${updateClauses.length === 0 ? 'IGNORE ' : ''}INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;
    if (updateClauses.length > 0) {
      query += ` ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}`;
    }

    for (const row of data) {
      const values = columns.map(col => row[col]);
      await connection.query(query, values);
    }
  }

  /**
   * 恢复提交成功后清理/重载运行时缓存，使进程内状态与数据库收敛。
   * 单个 reload 失败只记录告警，不影响已成功的恢复结果，也不阻断其余 reload。
   */
  private async reloadRuntimeCaches(): Promise<void> {
    // providers/models/virtual_keys 全部可能被恢复覆盖，直接整体失效。
    hotConfigCache.clear();

    const reloads: Array<[string, () => Promise<void>]> = [
      ['runtimeSystemConfigCache.reloadCorsEnabled', () => runtimeSystemConfigCache.reloadCorsEnabled()],
      ['reasoningEffortSuffixesCache.reload', () => reasoningEffortSuffixesCache.reload()],
      ['antiBotService.reloadConfig', () => antiBotService.reloadConfig()],
      ['requestHeaderForwardingService.reloadConfig', () => requestHeaderForwardingService.reloadConfig()],
      ['upstreamSslConfigService.reloadConfig', () => upstreamSslConfigService.reloadConfig()],
    ];

    for (const [name, reload] of reloads) {
      try {
        await reload();
      } catch (error: any) {
        memoryLogger.warn(`Post-restore cache reload failed (${name}): ${error?.message || error}`, 'Restore');
      }
    }
  }

  /** 清理临时文件；任何清理错误只记录日志，绝不抛出。 */
  private cleanupTempArtifacts(
    extractDir: string,
    encryptedPath: string,
    tarPath: string
  ): void {
    for (const target of [extractDir, encryptedPath, tarPath]) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (error: any) {
        memoryLogger.warn(`Failed to clean up temp file ${target}: ${error?.message || error}`, 'Restore');
      }
    }
  }

  async rollbackRestore(restoreId: string): Promise<void> {
    const restoreRecord = await restoreDb.getRestoreRecord(restoreId);
    if (!restoreRecord) {
      throw new Error(`Restore record not found: ${restoreId}`);
    }

    if (!restoreRecord.backup_before_restore) {
      throw new Error('No safety backup available for rollback');
    }

    memoryLogger.info(`Rolling back restore ${restoreId}`, 'Restore');

    await this.restoreFromBackup(restoreRecord.backup_before_restore, {
      restore_type: 'full',
      create_backup_before_restore: false
    });

    await restoreDb.updateRestoreRecord(restoreId, {
      status: 'rollback'
    });

    memoryLogger.info(`Rollback completed for restore ${restoreId}`, 'Restore');
  }

  async validateRestoreEnvironment(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const pool = getPool();

    try {
      await pool.query('SELECT 1');
    } catch (error) {
      errors.push('Database connection failed');
    }

    try {
      const s3Service = getS3Service();
      const connected = await s3Service.testConnection();
      if (!connected) {
        errors.push('S3 connection failed');
      }
    } catch (error) {
      errors.push('S3 service not configured');
    }

    try {
      mkdirSync(this.tempDir, { recursive: true });
    } catch (error) {
      errors.push('Cannot create temp directory');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}
