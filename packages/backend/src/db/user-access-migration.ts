import type { Connection } from 'mysql2/promise';
import type { Migration } from './migrations.js';

export async function ensureUserVirtualKeysTable(conn: Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS user_virtual_keys (
      user_id VARCHAR(255) NOT NULL,
      virtual_key_id VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
      PRIMARY KEY (user_id, virtual_key_id),
      INDEX idx_user_virtual_keys_key (virtual_key_id),
      FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export const userVirtualKeysMigration: Migration = {
  version: 9,
  name: 'user_virtual_keys_binding',
  up: async (conn) => {
    const [tables] = await conn.query(`SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys'`);
    if ((tables as Array<{ name: string }>).length > 0) await ensureUserVirtualKeysTable(conn);
  },
  down: async (conn) => { await conn.query('DROP TABLE IF EXISTS user_virtual_keys'); },
};
