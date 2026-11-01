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
  {
    // 2.0 客户端压缩方案：网关侧摘要压缩（dynamic_compression_enabled）删除，
    // 改为虚拟密钥级上下文预算档位（context_budget_tokens，NULL=关闭）。
    version: 2,
    name: "virtual_keys_context_budget",
    up: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) {
        // 空库：表由 schema.ts 连同新列一起创建，只登记版本号。
        return;
      }
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys' AND COLUMN_NAME IN ('context_budget_tokens', 'dynamic_compression_enabled')`,
      );
      const names = new Set(
        (columns as Array<{ name: string }>).map((row) => row.name),
      );
      if (!names.has("context_budget_tokens")) {
        await conn.query(
          "ALTER TABLE virtual_keys ADD COLUMN context_budget_tokens BIGINT DEFAULT NULL COMMENT '上下文预算档位 tokens，NULL=关闭；超预算的边界请求返回 context_length_exceeded' AFTER disable_logging",
        );
      }
      if (names.has("dynamic_compression_enabled")) {
        await conn.query(
          "ALTER TABLE virtual_keys DROP COLUMN dynamic_compression_enabled",
        );
      }
    },
    down: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) return;
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys' AND COLUMN_NAME IN ('context_budget_tokens', 'dynamic_compression_enabled')`,
      );
      const names = new Set(
        (columns as Array<{ name: string }>).map((row) => row.name),
      );
      if (names.has("context_budget_tokens")) {
        await conn.query(
          "ALTER TABLE virtual_keys DROP COLUMN context_budget_tokens",
        );
      }
      if (!names.has("dynamic_compression_enabled")) {
        await conn.query(
          "ALTER TABLE virtual_keys ADD COLUMN dynamic_compression_enabled TINYINT DEFAULT 0 AFTER disable_logging",
        );
      }
    },
  },
  {
    // Prompt 样本已下线：删表，并去掉虚拟密钥上的采集开关。
    version: 3,
    name: "drop_prompt_samples",
    up: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('prompt_samples', 'virtual_keys')`,
      );
      const names = new Set(
        (tables as Array<{ name: string }>).map((row) => row.name),
      );
      if (names.size === 0) return;
      if (names.has("prompt_samples")) {
        await conn.query("DROP TABLE prompt_samples");
      }
      if (!names.has("virtual_keys")) return;
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys' AND COLUMN_NAME = 'prompt_capture_enabled'`,
      );
      if ((columns as Array<{ name: string }>).length > 0) {
        await conn.query(
          "ALTER TABLE virtual_keys DROP COLUMN prompt_capture_enabled",
        );
      }
    },
    down: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) return;
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_keys' AND COLUMN_NAME = 'prompt_capture_enabled'`,
      );
      if ((columns as Array<{ name: string }>).length === 0) {
        await conn.query(
          "ALTER TABLE virtual_keys ADD COLUMN prompt_capture_enabled TINYINT DEFAULT 0 AFTER pii_protection_enabled",
        );
      }
      const [sampleTables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'prompt_samples'`,
      );
      if ((sampleTables as Array<{ name: string }>).length === 0) {
        await conn.query(`
          CREATE TABLE prompt_samples (
            id VARCHAR(255) PRIMARY KEY,
            virtual_key_id VARCHAR(255) NOT NULL,
            model VARCHAR(255) NOT NULL DEFAULT 'unknown',
            protocol VARCHAR(50) NOT NULL,
            intent_text MEDIUMTEXT NOT NULL,
            prompt_tokens INT NOT NULL DEFAULT 0,
            intent_truncated TINYINT NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL,
            INDEX idx_prompt_samples_virtual_key (virtual_key_id, created_at),
            INDEX idx_prompt_samples_created_at (created_at),
            FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      }
    },
  },
  {
    version: 4,
    name: "model_daily_usage_batches",
    up: async (conn) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS model_daily_usage_batches (
          batch_id VARCHAR(64) PRIMARY KEY COMMENT '单次用量 flush 的幂等标识',
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
    down: async (conn) => {
      await conn.query("DROP TABLE IF EXISTS model_daily_usage_batches");
    },
  },
  {
    // 旧全局额度（system_config.model_daily_token_limits + model_daily_usage*）
    // 停止生效但数据保留，故这里不 DROP 旧表。
    version: 5,
    name: "virtual_key_model_quotas",
    up: async (conn) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS virtual_key_model_quotas (
          virtual_key_id VARCHAR(255) NOT NULL,
          model VARCHAR(255) NOT NULL COMMENT '客户端请求的模型名 models.name（额度计量单位）',
          limit_millions DECIMAL(12,3) NOT NULL COMMENT '上海自然日 token 上限（单位 M）',
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          updated_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          PRIMARY KEY (virtual_key_id, model),
          INDEX idx_vk_model_quotas_model (model),
          FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS virtual_key_model_daily_usage (
          usage_date DATE NOT NULL COMMENT '网关时区自然日（默认 Asia/Shanghai）',
          virtual_key_id VARCHAR(255) NOT NULL,
          model VARCHAR(255) NOT NULL COMMENT '客户端请求的模型名 models.name（额度计量单位）',
          consumed_tokens BIGINT NOT NULL DEFAULT 0 COMMENT 'prompt+completion 累计；命中缓存不打折，同样计入',
          request_count INT NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          updated_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          PRIMARY KEY (usage_date, virtual_key_id, model),
          INDEX idx_vk_model_daily_usage_model (model, usage_date),
          FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS virtual_key_model_daily_usage_batches (
          batch_id VARCHAR(64) PRIMARY KEY COMMENT '单次用量 flush 的幂等标识',
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
    down: async (conn) => {
      await conn.query(
        "DROP TABLE IF EXISTS virtual_key_model_daily_usage_batches",
      );
      await conn.query(
        "DROP TABLE IF EXISTS virtual_key_model_daily_usage",
      );
      await conn.query("DROP TABLE IF EXISTS virtual_key_model_quotas");
    },
  },
  {
    // 与 schema.ts 同步建表；只用 CREATE TABLE IF NOT EXISTS，不用 ALTER/DROP，重入才安全。
    version: 6,
    name: "login_ip_lockout",
    up: async (conn) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS login_attempt_lockouts (
          ip VARCHAR(45) NOT NULL COMMENT '客户端 IP（可信代理网段内取 XFF 首项，否则取直连对端）',
          username VARCHAR(64) NOT NULL COMMENT '登录名规范化（小写、截断 64）；与 ip 组成封锁桶',
          failed_attempts INT NOT NULL DEFAULT 0 COMMENT '本轮连续失败次数；成功登录或封锁到期后重新计数',
          first_failed_at BIGINT NOT NULL DEFAULT 0 COMMENT '本轮首次失败时间戳(ms)',
          last_failed_at BIGINT NOT NULL DEFAULT 0 COMMENT '最近一次失败时间戳(ms)',
          locked_until BIGINT NOT NULL DEFAULT 0 COMMENT '封锁截止绝对时间戳(ms)，0=未封锁',
          updated_at BIGINT NOT NULL,
          PRIMARY KEY (ip, username),
          INDEX idx_login_attempt_lockouts_last_failed (last_failed_at),
          INDEX idx_login_attempt_lockouts_locked_until (locked_until)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS login_lockout_events (
          id VARCHAR(64) PRIMARY KEY,
          code VARCHAR(64) NOT NULL UNIQUE COMMENT '每次封锁唯一，alert_reads 按用户记录已读',
          ip VARCHAR(45) NOT NULL COMMENT '触发封锁的客户端 IP',
          username VARCHAR(64) NOT NULL DEFAULT '' COMMENT '被封锁的登录名（规范化后）',
          failed_attempts INT NOT NULL,
          locked_until BIGINT NOT NULL COMMENT '封锁截止绝对时间戳(ms)',
          created_at BIGINT NOT NULL,
          INDEX idx_login_lockout_events_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
    down: async (conn) => {
      await conn.query("DROP TABLE IF EXISTS login_lockout_events");
      await conn.query("DROP TABLE IF EXISTS login_attempt_lockouts");
    },
  },
  {
    // 周额度：新增 weekly_limit_millions，并把 limit_millions 改为可空，
    // 让两个额度维度可以独立设置/清除（NULL=未设，双 NULL 行由仓库层删除）。
    version: 7,
    name: "virtual_key_model_quotas_weekly_limit",
    up: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_key_model_quotas'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) {
        // 空库（scratch 干跑 / rebuild 先跑 migrations 后建表）：表由 schema.ts
        // 连同新列一起创建，这里只登记版本号，绝不先跑 DDL。
        return;
      }
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_key_model_quotas'
           AND COLUMN_NAME IN ('limit_millions', 'weekly_limit_millions')`,
      );
      const info = new Map(
        (columns as Array<{ name: string; nullable: string }>).map((row) => [
          row.name,
          row.nullable,
        ]),
      );
      if (!info.has("weekly_limit_millions")) {
        await conn.query(
          "ALTER TABLE virtual_key_model_quotas ADD COLUMN weekly_limit_millions DECIMAL(12,3) NULL DEFAULT NULL COMMENT '网关时区自然周（周一起算）token 上限（单位 M）；NULL=未设周额度' AFTER limit_millions",
        );
      }
      if (info.get("limit_millions") === "NO") {
        await conn.query(
          "ALTER TABLE virtual_key_model_quotas MODIFY COLUMN limit_millions DECIMAL(12,3) NULL DEFAULT NULL COMMENT '网关时区自然日 token 上限（单位 M）；NULL=未设日额度'",
        );
      }
    },
    down: async (conn) => {
      const [tables] = await conn.query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_key_model_quotas'`,
      );
      if ((tables as Array<{ name: string }>).length === 0) return;
      const [columns] = await conn.query(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'virtual_key_model_quotas'
           AND COLUMN_NAME IN ('limit_millions', 'weekly_limit_millions')`,
      );
      const names = new Set(
        (columns as Array<{ name: string }>).map((row) => row.name),
      );
      if (names.has("weekly_limit_millions")) {
        await conn.query(
          "ALTER TABLE virtual_key_model_quotas DROP COLUMN weekly_limit_millions",
        );
      }
      if (names.has("limit_millions")) {
        // 回滚前先把日额度 NULL 归零，恢复 NOT NULL 才不会失败。
        await conn.query(
          "UPDATE virtual_key_model_quotas SET limit_millions = 0 WHERE limit_millions IS NULL",
        );
        await conn.query(
          "ALTER TABLE virtual_key_model_quotas MODIFY COLUMN limit_millions DECIMAL(12,3) NOT NULL COMMENT '上海自然日 token 上限（单位 M）'",
        );
      }
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
