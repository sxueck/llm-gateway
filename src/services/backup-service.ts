import { getPool } from '../db/index.js';
import { backupDb } from '../db/backup.js';
import { getS3Service } from './s3-storage.js';
import { memoryLogger } from './logger.js';
import type { BackupOptions, BackupRecord } from '../types/index.js';
import { createWriteStream, createReadStream, mkdirSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import { createGzip, createGunzip } from 'zlib';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { join } from 'path';
import * as tar from 'tar';

const BACKUP_TABLES = [
  'users',
  'providers',
  'models',
  'virtual_keys',
  'system_config',
  'routing_configs',
  'expert_routing_configs'
];

const LOG_TABLES = [
  'api_requests',
  'expert_routing_logs',
  'health_runs',
  'health_summaries'
];

export class BackupService {
  private tempDir: string;
  private encryptionKey: Buffer;

  constructor() {
    this.tempDir = process.env.BACKUP_TEMP_DIR || join(process.cwd(), 'temp', 'backups');
    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters for backup encryption');
    }
    this.encryptionKey = Buffer.from(jwtSecret.slice(0, 32), 'utf-8');
  }

  async createFullBackup(options: BackupOptions = {}): Promise<BackupRecord> {
    return this.createBackup({ ...options, backup_type: 'full' });
  }

  async createIncrementalBackup(options: BackupOptions = {}): Promise<BackupRecord> {
    return this.createBackup({ ...options, backup_type: 'incremental' });
  }

  private async createBackup(options: BackupOptions = {}): Promise<BackupRecord> {
    const backupId = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const timestamp = Date.now();
    const backupType = options.backup_type || 'full';

    try {
      // Create backup record
      const backupRecord = await backupDb.createBackupRecord({
        id: backupId,
        backup_key: `${backupId}.tar.gz.enc`,
        backup_type: backupType,
        includes_logs: options.includes_logs ? 1 : 0,
        file_size: null,
        file_hash: null,
        s3_key: this.generateS3Key(backupId),
        encryption_key_hash: this.getEncryptionKeyHash(),
        status: 'running',
        started_at: timestamp,
        completed_at: null,
        error_message: null,
        record_count: null,
        checksum: null
      });

      memoryLogger.info(`Starting ${backupType} backup: ${backupId}`, 'Backup');

      // Create temp directory
      mkdirSync(this.tempDir, { recursive: true });
      const backupDir = join(this.tempDir, backupId);
      mkdirSync(backupDir, { recursive: true });
      mkdirSync(join(backupDir, 'data'), { recursive: true });

      // Get last successful backup for incremental
      let lastBackupTimestamp = 0;
      if (backupType === 'incremental') {
        const lastBackup = await backupDb.getLastCompletedBackup();
        if (lastBackup) {
          lastBackupTimestamp = lastBackup.completed_at || 0;
          memoryLogger.info(`Incremental backup since: ${new Date(lastBackupTimestamp).toISOString()}`, 'Backup');
        } else {
          memoryLogger.info('No previous backup found, performing full backup', 'Backup');
        }
      }

      // Export metadata
      const metadata = {
        backup_id: backupId,
        backup_type: backupType,
        includes_logs: options.includes_logs || false,
        timestamp,
        last_backup_timestamp: lastBackupTimestamp,
        version: '1.0'
      };
      await this.writeJsonFile(join(backupDir, 'metadata.json'), metadata);

      // Export database schema
      await this.exportSchema(join(backupDir, 'schema.sql'));

      // Export core data
      const tablesToBackup = [...BACKUP_TABLES];
      if (options.includes_logs) {
        tablesToBackup.push(...LOG_TABLES);
        mkdirSync(join(backupDir, 'logs'), { recursive: true });
      }

      let totalRecords = 0;
      for (const table of tablesToBackup) {
        const recordCount = await this.exportTableData(
          table,
          join(backupDir, options.includes_logs && LOG_TABLES.includes(table) ? 'logs' : 'data', `${table}.json`),
          backupType === 'incremental' ? lastBackupTimestamp : 0
        );
        totalRecords += recordCount;
      }

      // Create checksum
      const checksum = await this.createChecksum(backupDir);
      await this.writeJsonFile(join(backupDir, 'checksum.md5'), { checksum });

      // Create index
      const index = {
        backup_id: backupId,
        tables: tablesToBackup,
        record_count: totalRecords,
        created_at: timestamp
      };
      await this.writeJsonFile(join(backupDir, 'index.json'), index);

      // Create tar.gz archive
      const tarPath = join(this.tempDir, `${backupId}.tar.gz`);
      await tar.create(
        {
          gzip: true,
          file: tarPath,
          cwd: this.tempDir
        },
        [backupId]
      );

      // Encrypt archive
      const encryptedPath = join(this.tempDir, `${backupId}.tar.gz.enc`);
      await this.encryptFile(tarPath, encryptedPath);

      // Get file size and hash
      const fs = await import('fs/promises');
      const stats = await fs.stat(encryptedPath);
      const fileHash = await this.getFileHash(encryptedPath);

      // Upload to S3
      const s3Service = getS3Service();
      await s3Service.uploadFile(encryptedPath, backupRecord.s3_key);

      // Update backup record
      await backupDb.updateBackupRecord(backupId, {
        status: 'completed',
        completed_at: Date.now(),
        file_size: stats.size,
        file_hash: fileHash,
        record_count: totalRecords,
        checksum
      });

      // Cleanup temp files
      rmSync(backupDir, { recursive: true, force: true });
      await fs.unlink(tarPath);
      await fs.unlink(encryptedPath);

      memoryLogger.info(`Backup completed: ${backupId} (${totalRecords} records)`, 'Backup');

      return await backupDb.getBackupRecord(backupId) as BackupRecord;
    } catch (error: any) {
      memoryLogger.error(`Backup failed: ${error.message}`, 'Backup');

      await backupDb.updateBackupRecord(backupId, {
        status: 'failed',
        completed_at: Date.now(),
        error_message: error.message
      });

      throw error;
    }
  }

  private async exportSchema(outputPath: string): Promise<void> {
    const pool = getPool();
    const [rows] = await pool.query('SHOW TABLES');
    const tables = (rows as any[]).map(row => Object.values(row)[0] as string);

    let schema = '';
    for (const table of tables) {
      const [createRows] = await pool.query(`SHOW CREATE TABLE \`${table}\``);
      const createStatement = (createRows as any[])[0]['Create Table'];
      schema += `${createStatement};\n\n`;
    }

    const fs = await import('fs/promises');
    await fs.writeFile(outputPath, schema, 'utf-8');
  }

  private async exportTableData(
    tableName: string,
    outputPath: string,
    sinceTimestamp: number = 0
  ): Promise<number> {
    const pool = getPool();

    let query = `SELECT * FROM \`${tableName}\``;
    const params: any[] = [];

    // For incremental backups, filter by created_at or updated_at
    if (sinceTimestamp > 0) {
      // Check if table has created_at or updated_at column
      const [columns] = await pool.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         AND COLUMN_NAME IN ('created_at', 'updated_at')`,
        [tableName]
      );

      const columnNames = (columns as any[]).map(col => col.COLUMN_NAME);

      if (columnNames.includes('updated_at')) {
        query += ` WHERE updated_at > ?`;
        params.push(sinceTimestamp);
      } else if (columnNames.includes('created_at')) {
        query += ` WHERE created_at > ?`;
        params.push(sinceTimestamp);
      }
      // If table has no timestamp columns, backup all data (treat as full backup for this table)
    }

    const [rows] = await pool.query(query, params);
    await this.writeJsonFile(outputPath, rows);
    return (rows as any[]).length;
  }

  private async writeJsonFile(path: string, data: any): Promise<void> {
    const fs = await import('fs/promises');
    await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async encryptFile(inputPath: string, outputPath: string): Promise<void> {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.encryptionKey, iv);

    const input = createReadStream(inputPath);
    const output = createWriteStream(outputPath);

    // Write IV to the beginning of the file
    output.write(iv);

    await pipeline(input, cipher, output);
  }

  async decryptFile(inputPath: string, outputPath: string): Promise<void> {
    const fs = await import('fs/promises');
    const data = await fs.readFile(inputPath);

    // Extract IV from the beginning
    const iv = data.slice(0, 16);
    const encryptedData = data.slice(16);

    const decipher = createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

    await fs.writeFile(outputPath, decrypted);
  }

  private async createChecksum(dirPath: string): Promise<string> {
    const hash = createHash('md5');
    const fs = await import('fs/promises');

    const files = await fs.readdir(dirPath, { recursive: true });
    for (const file of files) {
      const filePath = join(dirPath, file as string);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath);
        hash.update(content);
      }
    }

    return hash.digest('hex');
  }

  private async getFileHash(filePath: string): Promise<string> {
    const fs = await import('fs/promises');
    const data = await fs.readFile(filePath);
    return createHash('md5').update(data).digest('hex');
  }

  private getEncryptionKeyHash(): string {
    return createHash('sha256').update(this.encryptionKey).digest('hex');
  }

  private generateS3Key(backupId: string): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `backups/${year}/${month}/${day}/${backupId}.tar.gz.enc`;
  }

  async verifyBackup(backupId: string): Promise<boolean> {
    try {
      const record = await backupDb.getBackupRecord(backupId);
      if (!record || record.status !== 'completed') {
        return false;
      }

      // Verify encryption key
      if (record.encryption_key_hash !== this.getEncryptionKeyHash()) {
        memoryLogger.error('Encryption key mismatch for backup verification', 'Backup');
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }
}
