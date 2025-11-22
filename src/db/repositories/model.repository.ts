import { getDatabase } from '../connection.js';
import { Model } from '../types.js';

export const modelRepository = {
  async getAll(): Promise<Model[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models ORDER BY created_at DESC');
      return rows as Model[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<Model | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models WHERE id = ?', [id]);
      const models = rows as any[];
      if (models.length === 0) return undefined;
      return models[0];
    } finally {
      conn.release();
    }
  },

  async getByProviderId(providerId: string): Promise<Model[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM models WHERE provider_id = ? ORDER BY created_at DESC', [providerId]);
      return rows as Model[];
    } finally {
      conn.release();
    }
  },

  async create(model: Omit<Model, 'created_at' | 'updated_at'>): Promise<Model> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO models (id, name, provider_id, model_identifier, protocol, is_virtual, routing_config_id, expert_routing_id, enabled, model_attributes, prompt_config, compression_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [model.id, model.name, model.provider_id, model.model_identifier, model.protocol || null, model.is_virtual, model.routing_config_id, model.expert_routing_id || null, model.enabled, model.model_attributes, model.prompt_config, model.compression_config, now, now]
      );
      return { ...model, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<Model, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      Object.entries(updates).forEach(([key, value]) => {
        fields.push(`${key} = ?`);
        values.push(value);
      });

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM models WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async countByProviderId(providerId: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT COUNT(*) as count FROM models WHERE provider_id = ?', [providerId]);
      const result = rows as any[];
      return result[0].count;
    } finally {
      conn.release();
    }
  },
};
