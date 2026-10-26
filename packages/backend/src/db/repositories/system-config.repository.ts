import type { PoolConnection } from 'mysql2/promise';
import { getDatabase } from '../connection.js';
import { SystemConfig } from '../../types/index.js';

export const systemConfigRepository = {
  async get(key: string, connection?: PoolConnection): Promise<SystemConfig | undefined> {
    const conn = connection ?? await getDatabase().getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM system_config WHERE `key` = ?', [key]);
      const configs = rows as any[];
      if (configs.length === 0) return undefined;
      return configs[0];
    } finally {
      if (!connection) conn.release();
    }
  },

  async set(key: string, value: string, description?: string, connection?: PoolConnection): Promise<void> {
    const now = Date.now();
    const conn = connection ?? await getDatabase().getConnection();
    try {
      const existing = await this.get(key, conn);

      if (existing) {
        await conn.query(
          'UPDATE system_config SET value = ?, description = ?, updated_at = ? WHERE `key` = ?',
          [value, description || null, now, key]
        );
      } else {
        await conn.query(
          'INSERT INTO system_config (`key`, value, description, updated_at) VALUES (?, ?, ?, ?)',
          [key, value, description || null, now]
        );
      }
    } finally {
      if (!connection) conn.release();
    }
  },
};
