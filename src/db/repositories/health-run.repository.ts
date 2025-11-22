import { getDatabase } from '../connection.js';
import { HealthRun } from '../types.js';

export const healthRunRepository = {
  async create(run: Omit<HealthRun, 'created_at'>): Promise<HealthRun> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO health_runs (id, target_id, status, latency_ms, error_type, error_message, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [run.id, run.target_id, run.status, run.latency_ms, run.error_type || null, run.error_message || null, run.request_id || null, now]
      );
      return { ...run, created_at: now };
    } finally {
      conn.release();
    }
  },

  async getByTargetId(targetId: string, limit: number = 100): Promise<HealthRun[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM health_runs WHERE target_id = ? ORDER BY created_at DESC LIMIT ?',
        [targetId, limit]
      );
      return rows as HealthRun[];
    } finally {
      conn.release();
    }
  },

  async getByTimeWindow(targetId: string, startTime: number, endTime: number): Promise<HealthRun[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM health_runs WHERE target_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC',
        [targetId, startTime, endTime]
      );
      return rows as HealthRun[];
    } finally {
      conn.release();
    }
  },

  async getStats(targetId: string, startTime: number, endTime: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
          COUNT(*) as total_checks,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
          AVG(latency_ms) as avg_latency,
          MIN(latency_ms) as min_latency,
          MAX(latency_ms) as max_latency
        FROM health_runs
        WHERE target_id = ? AND created_at >= ? AND created_at <= ?`,
        [targetId, startTime, endTime]
      );
      const result = rows as any[];
      if (result.length === 0) {
        return {
          totalChecks: 0,
          successCount: 0,
          errorCount: 0,
          avgLatency: 0,
          minLatency: 0,
          maxLatency: 0,
        };
      }
      return {
        totalChecks: result[0].total_checks || 0,
        successCount: result[0].success_count || 0,
        errorCount: result[0].error_count || 0,
        avgLatency: Math.round(result[0].avg_latency || 0),
        minLatency: result[0].min_latency || 0,
        maxLatency: result[0].max_latency || 0,
      };
    } finally {
      conn.release();
    }
  },

  async cleanOldRecords(daysToKeep: number = 7): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query('DELETE FROM health_runs WHERE created_at < ?', [cutoffTime]);
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },
};
