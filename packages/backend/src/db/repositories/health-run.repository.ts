import { getDatabase } from '../connection.js';
import { HealthRun } from '../types.js';

const HEALTH_RUN_STATS_COLUMNS = `COUNT(*) AS total_checks,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
                AVG(latency_ms) AS avg_latency,
                MIN(latency_ms) AS min_latency,
                MAX(latency_ms) AS max_latency`;

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

  async getTargetPage(
    targetId: string,
    startTime: number,
    endTime: number,
    limit: number,
    offset: number,
  ): Promise<HealthRun[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const windowSql = startTime > 0 ? ' AND created_at >= ? AND created_at <= ?' : '';
      const params = startTime > 0
        ? [targetId, startTime, endTime, limit, offset]
        : [targetId, limit, offset];
      const [rows] = await conn.query(
        `SELECT * FROM health_runs
         WHERE target_id = ?${windowSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        params,
      );
      return rows as HealthRun[];
    } finally {
      conn.release();
    }
  },

  async countByTarget(
    targetId: string,
    startTime: number,
    endTime: number,
  ): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const windowSql = startTime > 0 ? ' AND created_at >= ? AND created_at <= ?' : '';
      const params = startTime > 0 ? [targetId, startTime, endTime] : [targetId];
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS total
         FROM health_runs
         WHERE target_id = ?${windowSql}`,
        params,
      );
      return Number((rows as any[])[0]?.total || 0);
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

  async getByTargetsTimeWindow(
    targetIds: string[],
    startTime: number,
    endTime: number,
  ): Promise<Map<string, HealthRun[]>> {
    const result = new Map<string, HealthRun[]>();
    if (targetIds.length === 0) return result;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const placeholders = targetIds.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT * FROM health_runs
         WHERE target_id IN (${placeholders})
           AND created_at >= ? AND created_at <= ?
         ORDER BY target_id ASC, created_at ASC`,
        [...targetIds, startTime, endTime],
      );
      for (const row of rows as HealthRun[]) {
        const runs = result.get(row.target_id);
        if (runs) runs.push(row);
        else result.set(row.target_id, [row]);
      }
      return result;
    } finally {
      conn.release();
    }
  },

  async getRecentByTargets(
    targetIds: string[],
    limit: number,
  ): Promise<Map<string, HealthRun[]>> {
    const result = new Map<string, HealthRun[]>();
    if (targetIds.length === 0 || limit <= 0) return result;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const placeholders = targetIds.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT id, target_id, status, latency_ms, error_type, error_message, request_id, created_at
         FROM (
           SELECT hr.*,
                  ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY created_at DESC) AS row_num
           FROM health_runs hr
           WHERE target_id IN (${placeholders})
         ) ranked
         WHERE row_num <= ?
         ORDER BY target_id ASC, created_at DESC`,
        [...targetIds, limit],
      );
      for (const row of rows as HealthRun[]) {
        const runs = result.get(row.target_id);
        if (runs) runs.push(row);
        else result.set(row.target_id, [row]);
      }
      return result;
    } finally {
      conn.release();
    }
  },

  async getStatsByTargets(
    targetIds: string[],
    startTime: number,
    endTime: number,
  ): Promise<Map<string, {
    totalChecks: number;
    successCount: number;
    errorCount: number;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
  }>> {
    const result = new Map<string, {
      totalChecks: number;
      successCount: number;
      errorCount: number;
      avgLatency: number;
      minLatency: number;
      maxLatency: number;
    }>();
    if (targetIds.length === 0) return result;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const placeholders = targetIds.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT target_id, ${HEALTH_RUN_STATS_COLUMNS}
         FROM health_runs
         WHERE target_id IN (${placeholders})
           AND created_at >= ? AND created_at <= ?
         GROUP BY target_id`,
        [...targetIds, startTime, endTime],
      );
      for (const row of rows as any[]) {
        result.set(row.target_id, {
          totalChecks: Number(row.total_checks) || 0,
          successCount: Number(row.success_count) || 0,
          errorCount: Number(row.error_count) || 0,
          avgLatency: Math.round(Number(row.avg_latency) || 0),
          minLatency: Number(row.min_latency) || 0,
          maxLatency: Number(row.max_latency) || 0,
        });
      }
      return result;
    } finally {
      conn.release();
    }
  },

  async getStats(targetId: string, startTime: number, endTime: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ${HEALTH_RUN_STATS_COLUMNS}
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
