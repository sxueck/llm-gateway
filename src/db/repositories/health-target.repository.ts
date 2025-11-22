import { getDatabase } from '../connection.js';
import { HealthTarget } from '../types.js';

export const healthTargetRepository = {
  async getAll(): Promise<HealthTarget[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM health_targets ORDER BY created_at DESC');
      return rows as HealthTarget[];
    } finally {
      conn.release();
    }
  },

  async getEnabled(): Promise<HealthTarget[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM health_targets WHERE enabled = 1');
      return rows as HealthTarget[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<HealthTarget | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM health_targets WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async create(target: Omit<HealthTarget, 'created_at' | 'updated_at'>): Promise<HealthTarget> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO health_targets (id, name, type, target_id, enabled, check_interval_seconds, check_prompt, check_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [target.id, target.name, target.type, target.target_id, target.enabled, target.check_interval_seconds, target.check_prompt, target.check_config, now, now]
      );
      return { ...target, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<HealthTarget, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      });

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE health_targets SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM health_targets WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async getDueTargets(now: number): Promise<HealthTarget[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      // 查找需要执行检查的目标：启用的目标，且上次检查时间 + 检查间隔 <= 当前时间
      const [rows] = await conn.query(`
        SELECT ht.*
        FROM health_targets ht
        LEFT JOIN (
          SELECT target_id, MAX(created_at) as last_check
          FROM health_runs
          GROUP BY target_id
        ) hr ON ht.id = hr.target_id
        WHERE ht.enabled = 1
        AND (hr.last_check IS NULL OR (hr.last_check + ht.check_interval_seconds * 1000) <= ?)
      `, [now]);
      return rows as HealthTarget[];
    } finally {
      conn.release();
    }
  },
};
