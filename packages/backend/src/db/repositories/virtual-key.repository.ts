import { getDatabase } from '../connection.js';
import { VirtualKey } from '../../types/index.js';

// Count how many virtual keys reference each model id, including both
// single-model bindings (model_id) and multi-model bindings (model_ids JSON array).
async function countVirtualKeysByModelIds(modelIds: string[]): Promise<Map<string, number>> {
  if (modelIds.length === 0) return new Map();

  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const placeholders = modelIds.map(() => '?').join(',');

    // 1) Count keys bound via single model_id
    const [singleRows] = await conn.query(
      `SELECT model_id, COUNT(*) as count FROM virtual_keys WHERE model_id IN (${placeholders}) GROUP BY model_id`,
      modelIds
    );
    const map = new Map<string, number>();
    const single = singleRows as any[];
    single.forEach(row => {
      if (row.model_id) {
        map.set(row.model_id, Number(row.count) || 0);
      }
    });

    // 2) Count keys bound via multi-model model_ids (JSON array stored as TEXT)
    const [multiRows] = await conn.query(
      'SELECT model_ids FROM virtual_keys WHERE model_ids IS NOT NULL'
    );
    const multi = multiRows as any[];
    const idSet = new Set(modelIds);

    multi.forEach(row => {
      if (!row.model_ids) return;
      try {
        const parsed = JSON.parse(row.model_ids);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string' && idSet.has(id)) {
              map.set(id, (map.get(id) || 0) + 1);
            }
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    });

    return map;
  } finally {
    conn.release();
  }
}


export const virtualKeyRepository = {
  async getAll(): Promise<VirtualKey[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys ORDER BY created_at DESC');
      return rows as VirtualKey[];
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<VirtualKey | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys WHERE id = ?', [id]);
      const keys = rows as any[];
      if (keys.length === 0) return undefined;
      return keys[0];
    } finally {
      conn.release();
    }
  },

  async getByKeyValue(keyValue: string): Promise<VirtualKey | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM virtual_keys WHERE key_value = ?', [keyValue]);
      const keys = rows as any[];
      if (keys.length === 0) return undefined;
      return keys[0];
    } finally {
      conn.release();
    }
  },

  async create(vk: Omit<VirtualKey, 'created_at' | 'updated_at'>): Promise<VirtualKey> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO virtual_keys (
          id, key_value, key_hash, name, provider_id, model_id,
          routing_strategy, model_ids, routing_config,
          enabled, rate_limit, cache_enabled, disable_logging, dynamic_compression_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          vk.id,
          vk.key_value,
          vk.key_hash,
          vk.name,
          vk.provider_id || null,
          vk.model_id || null,
          vk.routing_strategy || 'single',
          vk.model_ids || null,
          vk.routing_config || null,
          vk.enabled,
          vk.rate_limit,
          vk.cache_enabled || 0,
          vk.disable_logging || 0,
          vk.dynamic_compression_enabled || 0,
          now,
          now
        ]
      );
      return { ...vk, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async update(id: string, updates: Partial<Omit<VirtualKey, 'id' | 'key_value' | 'key_hash' | 'created_at' | 'updated_at'>>): Promise<void> {
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

      await conn.query(`UPDATE virtual_keys SET ${fields.join(', ')} WHERE id = ?`, values);
    } finally {
      conn.release();
    }
  },

  async delete(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query('DELETE FROM virtual_keys WHERE id = ?', [id]);
    } finally {
      conn.release();
    }
  },

  async countByModelId(modelId: string): Promise<number> {
    const map = await countVirtualKeysByModelIds([modelId]);
    return map.get(modelId) || 0;
  },

  async countByModelIds(modelIds: string[]): Promise<Map<string, number>> {
    return countVirtualKeysByModelIds(modelIds);
  },
};
