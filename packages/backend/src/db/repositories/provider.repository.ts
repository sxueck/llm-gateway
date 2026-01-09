import { getDatabase } from '../connection.js';
import { Provider } from '../../types/index.js';

export const providerRepository = {
  async getAll(): Promise<Provider[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM providers ORDER BY created_at DESC');
      return rows as Provider[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<Provider | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM providers WHERE id = ?', [id]);
      const providers = rows as any[];
      if (providers.length === 0) return undefined;
      return providers[0];
    } finally {
      conn.release();
    }
  },

  async create(provider: Omit<Provider, 'created_at' | 'updated_at'>): Promise<Provider> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO providers (id, name, description, base_url, protocol_mappings, api_key, model_mapping, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [provider.id, provider.name, provider.description || null, provider.base_url, provider.protocol_mappings || null, provider.api_key, provider.model_mapping || null, provider.enabled, now, now]
      );
      return { ...provider, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<Provider, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.base_url !== undefined) {
        fields.push('base_url = ?');
        values.push(updates.base_url);
      }
      if (updates.protocol_mappings !== undefined) {
        fields.push('protocol_mappings = ?');
        values.push(updates.protocol_mappings);
      }
      if (updates.api_key !== undefined) {
        fields.push('api_key = ?');
        values.push(updates.api_key);
      }
      if (updates.model_mapping !== undefined) {
        fields.push('model_mapping = ?');
        values.push(updates.model_mapping);
      }
      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled);
      }

      if (fields.length === 0) return;

      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);

      await conn.query(`UPDATE providers SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM providers WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },
};
