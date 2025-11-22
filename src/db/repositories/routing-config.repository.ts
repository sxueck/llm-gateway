import { getDatabase } from '../connection.js';

export const routingConfigRepository = {
  async getAll() {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM routing_configs ORDER BY created_at DESC');
      return rows;
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM routing_configs WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async create(data: {
    id: string;
    name: string;
    description?: string;
    type: string;
    config: string;
    enabled: number;
  }) {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO routing_configs (id, name, description, type, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [data.id, data.name, data.description || null, data.type, data.config, data.enabled, now, now]
      );
      return { ...data, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, data: {
    name?: string;
    description?: string;
    type?: string;
    config?: string;
    enabled?: number;
  }) {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      Object.entries(data).forEach(([key, value]) => {
        fields.push(`${key} = ?`);
        values.push(value);
      });

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE routing_configs SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM routing_configs WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },
};
