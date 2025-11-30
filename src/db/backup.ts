import { getPool } from './index.js';
import type { BackupRecord, RestoreRecord } from '../types/index.js';

const getDbPool = () => getPool();

export const backupDb = {
  async createBackupRecord(record: Omit<BackupRecord, 'created_at'>) {
    const pool = getDbPool();
    const now = Date.now();
    await pool.query(
      `INSERT INTO backup_records
       (id, backup_key, backup_type, includes_logs, file_size, file_hash, s3_key,
        encryption_key_hash, status, started_at, completed_at, error_message,
        record_count, checksum, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.backup_key,
        record.backup_type,
        record.includes_logs,
        record.file_size,
        record.file_hash,
        record.s3_key,
        record.encryption_key_hash,
        record.status,
        record.started_at,
        record.completed_at,
        record.error_message,
        record.record_count,
        record.checksum,
        now
      ]
    );
    return { ...record, created_at: now };
  },

  async updateBackupRecord(id: string, updates: Partial<BackupRecord>) {
    const pool = getDbPool();
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) return;

    values.push(id);
    await pool.query(
      `UPDATE backup_records SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  },

  async getBackupRecord(id: string): Promise<BackupRecord | null> {
    const pool = getDbPool();
    const [rows] = await pool.query(
      'SELECT * FROM backup_records WHERE id = ?',
      [id]
    );
    const records = rows as BackupRecord[];
    return records.length > 0 ? records[0] : null;
  },

  async listBackupRecords(options: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<{ records: BackupRecord[]; total: number }> {
    const pool = getDbPool();
    const page = options.page || 1;
    const limit = options.limit || 10;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: any[] = [];

    if (options.status && options.status !== 'all') {
      whereClause = 'WHERE status = ?';
      params.push(options.status);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM backup_records ${whereClause}`,
      params
    );
    const total = (countRows as any[])[0].total;

    const [rows] = await pool.query(
      `SELECT * FROM backup_records ${whereClause}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      records: rows as BackupRecord[],
      total
    };
  },

  async deleteBackupRecord(id: string) {
    const pool = getDbPool();
    await pool.query('DELETE FROM backup_records WHERE id = ?', [id]);
  },

  async cleanupOldBackups(retentionDays: number, maxCount: number) {
    const pool = getDbPool();
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    // Get all backups ordered by creation time
    const [rows] = await pool.query(
      'SELECT id FROM backup_records ORDER BY created_at DESC'
    );
    const allBackups = rows as { id: string }[];

    // Delete backups older than retention period
    await pool.query('DELETE FROM backup_records WHERE created_at < ?', [
      cutoffTime
    ]);

    // Delete backups exceeding max count
    if (allBackups.length > maxCount) {
      const toDelete = allBackups.slice(maxCount);
      if (toDelete.length > 0) {
        await pool.query(
          'DELETE FROM backup_records WHERE id IN (?)',
          [toDelete.map(b => b.id)]
        );
      }
    }
  },

  async getLastCompletedBackup(): Promise<BackupRecord | null> {
    const pool = getDbPool();
    const [rows] = await pool.query(
      `SELECT * FROM backup_records
       WHERE status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`
    );
    const records = rows as BackupRecord[];
    return records.length > 0 ? records[0] : null;
  }
};

export const restoreDb = {
  async createRestoreRecord(record: Omit<RestoreRecord, 'created_at'>) {
    const pool = getDbPool();
    const now = Date.now();
    await pool.query(
      `INSERT INTO restore_records
       (id, backup_record_id, restore_type, status, started_at, completed_at,
        error_message, backup_before_restore, changes_made, rollback_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.backup_record_id,
        record.restore_type,
        record.status,
        record.started_at,
        record.completed_at,
        record.error_message,
        record.backup_before_restore,
        record.changes_made,
        record.rollback_data,
        now
      ]
    );
    return { ...record, created_at: now };
  },

  async updateRestoreRecord(id: string, updates: Partial<RestoreRecord>) {
    const pool = getDbPool();
    const fields: string[] = [];
    const values: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    });

    if (fields.length === 0) return;

    values.push(id);
    await pool.query(
      `UPDATE restore_records SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  },

  async getRestoreRecord(id: string): Promise<RestoreRecord | null> {
    const pool = getDbPool();
    const [rows] = await pool.query(
      'SELECT * FROM restore_records WHERE id = ?',
      [id]
    );
    const records = rows as RestoreRecord[];
    return records.length > 0 ? records[0] : null;
  },

  async listRestoreRecords(options: {
    page?: number;
    limit?: number;
    status?: string;
  }): Promise<{ records: RestoreRecord[]; total: number }> {
    const pool = getDbPool();
    const page = options.page || 1;
    const limit = options.limit || 10;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: any[] = [];

    if (options.status && options.status !== 'all') {
      whereClause = 'WHERE status = ?';
      params.push(options.status);
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM restore_records ${whereClause}`,
      params
    );
    const total = (countRows as any[])[0].total;

    const [rows] = await pool.query(
      `SELECT * FROM restore_records ${whereClause}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      records: rows as RestoreRecord[],
      total
    };
  }
};
