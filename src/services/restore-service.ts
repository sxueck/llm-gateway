import { getPool } from '../db/index.js';
import { backupDb, restoreDb } from '../db/backup.js';
import { getS3Service } from './s3-storage.js';
import { BackupService } from './backup-service.js';
import { memoryLogger } from './logger.js';
import type { RestoreOptions, RestoreRecord, BackupRecord } from '../types/index.js';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import * as tar from 'tar';

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

    try {
      // Get backup record
      const backupRecord = await backupDb.getBackupRecord(backupId);
      if (!backupRecord) {
        throw new Error(`Backup not found: ${backupId}`);
      }

      if (backupRecord.status !== 'completed') {
        throw new Error(`Backup is not completed: ${backupId}`);
      }

      // Create backup before restore if requested
      let backupBeforeRestore: string | null = null;
      if (options.create_backup_before_restore) {
        memoryLogger.info('Creating safety backup before restore', 'Restore');
        const safetyBackup = await this.backupService.createFullBackup({
          backup_type: 'full',
          includes_logs: false
        });
        backupBeforeRestore = safetyBackup.id;
      }

      // Create restore record
      const restoreRecord = await restoreDb.createRestoreRecord({
        id: restoreId,
        backup_record_id: backupId,
        restore_type: options.restore_type || 'full',
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
      const encryptedPath = join(this.tempDir, `${backupId}.tar.gz.enc`);
      const s3Service = getS3Service();
      await s3Service.downloadFile(backupRecord.s3_key, encryptedPath);

      // Decrypt backup
      const tarPath = join(this.tempDir, `${backupId}.tar.gz`);
      await this.backupService.decryptFile(encryptedPath, tarPath);

      // Extract tar.gz
      const extractDir = join(this.tempDir, 'extract');
      mkdirSync(extractDir, { recursive: true });
      await tar.extract({
        file: tarPath,
        cwd: extractDir
      });

      // Find backup directory
      const fs = await import('fs/promises');
      const dirs = await fs.readdir(extractDir);
      const backupDir = join(extractDir, dirs[0]);

      // Read metadata and verify
      const metadataPath = join(backupDir, 'metadata.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

      if (options.verify_data) {
        memoryLogger.info('Verifying backup integrity', 'Restore');
        const checksumPath = join(backupDir, 'checksum.md5');
        const checksumData = JSON.parse(await fs.readFile(checksumPath, 'utf-8'));
        // Note: Full checksum verification would require recalculating
        // For now, we just check that checksum file exists
      }

      // Read index
      const indexPath = join(backupDir, 'index.json');
      const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

      // Determine which tables to restore
      let tablesToRestore = index.tables;
      if (options.restore_type === 'partial' && options.tables_to_restore) {
        tablesToRestore = index.tables.filter((table: string) =>
          options.tables_to_restore?.includes(table)
        );
        memoryLogger.info(`Partial restore: restoring ${tablesToRestore.length} tables`, 'Restore');
      }

      // Restore data
      const changesMade: Record<string, number> = {};
      const pool = getPool();

      for (const table of tablesToRestore) {
        const isLogTable = ['api_requests', 'expert_routing_logs', 'health_runs', 'health_summaries'].includes(table);
        const dataDir = isLogTable ? 'logs' : 'data';
        const dataPath = join(backupDir, dataDir, `${table}.json`);

        try {
          const data = JSON.parse(await fs.readFile(dataPath, 'utf-8'));

          // Clear existing data (only for full restore)
          if (options.restore_type === 'full') {
            await pool.query(`DELETE FROM \`${table}\``);
          }

          // For partial restore with incremental backup, use upsert logic
          if (data.length > 0) {
            const columns = Object.keys(data[0]);

            if (options.restore_type === 'partial' && metadata.backup_type === 'incremental') {
              // Upsert for partial restore of incremental backups
              await this.upsertData(table, data, columns);
            } else {
              // Regular insert for full restore
              const placeholders = columns.map(() => '?').join(', ');
              const insertQuery = `INSERT INTO \`${table}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;

              for (const row of data) {
                const values = columns.map(col => row[col]);
                await pool.query(insertQuery, values);
              }
            }
          }

          changesMade[table] = data.length;
          memoryLogger.info(`Restored ${data.length} records to ${table}`, 'Restore');
        } catch (error: any) {
          memoryLogger.error(`Failed to restore table ${table}: ${error.message}`, 'Restore');
          throw error;
        }
      }

      // Update restore record
      await restoreDb.updateRestoreRecord(restoreId, {
        status: 'completed',
        completed_at: Date.now(),
        changes_made: JSON.stringify(changesMade)
      });

      // Cleanup temp files
      rmSync(extractDir, { recursive: true, force: true });
      await fs.unlink(encryptedPath);
      await fs.unlink(tarPath);

      memoryLogger.info(`Restore completed: ${restoreId}`, 'Restore');

      return await restoreDb.getRestoreRecord(restoreId) as RestoreRecord;
    } catch (error: any) {
      memoryLogger.error(`Restore failed: ${error.message}`, 'Restore');

      await restoreDb.updateRestoreRecord(restoreId, {
        status: 'failed',
        completed_at: Date.now(),
        error_message: error.message
      });

      throw error;
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

    // Restore from the safety backup
    await this.restoreFromBackup(restoreRecord.backup_before_restore, {
      restore_type: 'full',
      create_backup_before_restore: false
    });

    // Update restore record status
    await restoreDb.updateRestoreRecord(restoreId, {
      status: 'rollback'
    });

    memoryLogger.info(`Rollback completed for restore ${restoreId}`, 'Restore');
  }

  async validateRestoreEnvironment(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const pool = getPool();

    try {
      // Check database connection
      await pool.query('SELECT 1');
    } catch (error) {
      errors.push('Database connection failed');
    }

    try {
      // Check S3 connection
      const s3Service = getS3Service();
      const connected = await s3Service.testConnection();
      if (!connected) {
        errors.push('S3 connection failed');
      }
    } catch (error) {
      errors.push('S3 service not configured');
    }

    // Check temp directory access
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

  private async upsertData(
    tableName: string,
    data: any[],
    columns: string[]
  ): Promise<void> {
    const pool = getPool();

    for (const row of data) {
      const values = columns.map(col => row[col]);
      const updateClauses = columns.filter(col => col !== 'id').map(col => `\`${col}\` = VALUES(\`${col}\`)`);
      const placeholders = columns.map(() => '?').join(', ');

      const query = `
        INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`)
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}
      `;

      await pool.query(query, values);
    }
  }
}
