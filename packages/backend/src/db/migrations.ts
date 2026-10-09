import type { Connection } from "mysql2/promise";

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

// v2 starts from schema.ts; future incremental migrations start at version 1.
export const migrations: Migration[] = [
  {
    version: 1,
    name: "api_requests_session_id",
    up: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_requests'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) {
        // 空库（scratch 干跑 / rebuild 先跑 migrations 后建表）：表由 schema.ts
        // 连同 session_id 一起创建，这里只登记版本号，绝不先跑 DDL。
        return;
      }
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_requests' AND COLUMN_NAME = 'session_id'`,
      );
      if ((columns as Array<{ name: string }>).length === 0) {
        await conn.query(
          "ALTER TABLE api_requests ADD COLUMN session_id VARCHAR(256) DEFAULT NULL COMMENT '客户端显式会话标识（x-session-id 等），无则为 NULL' AFTER run_id",
        );
      }
      const [indexes] = await conn.query(
        `SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_requests' AND INDEX_NAME = 'idx_api_requests_session'`,
      );
      if ((indexes as Array<{ name: string }>).length === 0) {
        await conn.query(
          "ALTER TABLE api_requests ADD INDEX idx_api_requests_session (session_id, created_at)",
        );
      }
    },
    down: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_requests'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) return;
      const [indexes] = await conn.query(
        `SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_requests' AND INDEX_NAME = 'idx_api_requests_session'`,
      );
      if ((indexes as Array<{ name: string }>).length > 0) {
        await conn.query(
          "ALTER TABLE api_requests DROP INDEX idx_api_requests_session",
        );
      }
      await conn.query(
        "ALTER TABLE api_requests DROP COLUMN session_id",
      );
    },
  },
];

export async function getCurrentVersion(conn: Connection): Promise<number> {
  const [tables] = await conn.query(
    "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  const names = new Set((tables as Array<{ name: string }>).map((row) => row.name));
  if (!names.has("schema_baseline") && names.size > 0) {
    throw new Error("Legacy database detected. Run the explicit v2 upgrade export/rebuild before starting the gateway.");
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_baseline (
      id TINYINT PRIMARY KEY,
      generation INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [baseline] = await conn.query("SELECT generation FROM schema_baseline WHERE id = 1");
  const rows = baseline as Array<{ generation: number }>;
  if (rows.length === 0) {
    if (names.size > 0) {
      throw new Error("Missing database baseline. Restore or rebuild the database before starting the gateway.");
    }
    await conn.query("INSERT INTO schema_baseline (id, generation) VALUES (1, 2)");
  } else if (Number(rows[0].generation) !== 2) {
    throw new Error("Unsupported database baseline; expected v2.");
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [versions] = await conn.query("SELECT MAX(version) as version FROM schema_migrations");
  return Number((versions as Array<{ version: number | null }>)[0]?.version ?? 0);
}

export async function applyMigrations(conn: Connection): Promise<void> {
  const currentVersion = await getCurrentVersion(conn);
  for (const migration of migrations.filter((entry) => entry.version > currentVersion)) {
    await conn.beginTransaction();
    try {
      await migration.up(conn);
      await conn.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, Date.now()],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  }
}

export async function rollbackMigration(conn: Connection, targetVersion: number): Promise<void> {
  const currentVersion = await getCurrentVersion(conn);
  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new Error("Invalid migration target version");
  }
  const pending = migrations
    .filter((entry) => entry.version > targetVersion && entry.version <= currentVersion)
    .sort((a, b) => b.version - a.version);
  if (pending.some((entry) => !entry.down)) {
    throw new Error("Cannot roll back an irreversible migration");
  }
  for (const migration of pending) {
    await migration.down!(conn);
    await conn.query("DELETE FROM schema_migrations WHERE version = ?", [migration.version]);
  }
}
