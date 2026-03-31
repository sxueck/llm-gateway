import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    version: 31,
    name: 'add_api_request_daily_summaries',
    up: async (conn: Connection) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS api_request_daily_summaries (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          summary_date DATE NOT NULL COMMENT 'Asia/Shanghai 时区的汇总日期',
          virtual_key_id VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'NULL 时存储空字符串',
          provider_id VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'NULL 时存储空字符串',
          model VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'NULL 时存储空字符串',
          request_count INT NOT NULL DEFAULT 0,
          success_count INT NOT NULL DEFAULT 0,
          error_count INT NOT NULL DEFAULT 0,
          total_tokens BIGINT NOT NULL DEFAULT 0,
          prompt_tokens BIGINT NOT NULL DEFAULT 0,
          completion_tokens BIGINT NOT NULL DEFAULT 0,
          cached_tokens BIGINT NOT NULL DEFAULT 0,
          cache_hit_count INT NOT NULL DEFAULT 0 COMMENT 'cache_hit = 1 的计数',
          prompt_cache_hit_count INT NOT NULL DEFAULT 0 COMMENT 'cached_tokens > 0 的计数（即使用了 prompt cache）',
          total_response_time BIGINT NOT NULL DEFAULT 0,
          response_time_count INT NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          updated_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          UNIQUE KEY uk_daily_summary_dimensions (summary_date, virtual_key_id, provider_id, model),
          INDEX idx_summary_date (summary_date),
          INDEX idx_summary_virtual_key (virtual_key_id, summary_date),
          INDEX idx_summary_provider (provider_id, summary_date),
          INDEX idx_summary_model (model, summary_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[迁移] 已创建 api_request_daily_summaries 表');
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS api_request_daily_summaries');
      console.log('[迁移] 已删除 api_request_daily_summaries 表');
    }
  },
  {
    version: 32,
    name: 'add_prompt_cache_hit_count_to_summaries',
    up: async (conn: Connection) => {
      const hasColumn = async (columnName: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'api_request_daily_summaries'
             AND COLUMN_NAME = ?`,
          [columnName]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      if (!(await hasColumn('prompt_cache_hit_count'))) {
        await conn.query(`
          ALTER TABLE api_request_daily_summaries
          ADD COLUMN prompt_cache_hit_count INT NOT NULL DEFAULT 0
          COMMENT 'cached_tokens > 0 的计数（即使用了 prompt cache）'
          AFTER cache_hit_count
        `);
        console.log('[迁移] 已添加 api_request_daily_summaries.prompt_cache_hit_count 字段');
      }
    },
    down: async (conn: Connection) => {
      try {
        await conn.query(`ALTER TABLE api_request_daily_summaries DROP COLUMN IF EXISTS prompt_cache_hit_count`);
        console.log('[迁移] 已删除 api_request_daily_summaries.prompt_cache_hit_count 字段');
      } catch (e: any) {
        console.warn('[迁移] 删除 prompt_cache_hit_count 字段失败:', e.message);
      }
    }
  }
];

export async function getCurrentVersion(conn: Connection): Promise<number> {
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [rows] = await conn.query('SELECT MAX(version) as version FROM schema_migrations');
    const result = rows as any[];
    if (result.length > 0 && result[0].version !== null) {
      console.log(`已应用的迁移版本: v${result[0].version}`);
      return result[0].version;
    }

    console.log('未发现已应用的迁移,数据库版本为 v0');
    return 0;
  } catch (e: any) {
    console.error('获取数据库版本失败:', e.message);
    console.error('错误详情:', e);
    return 0;
  }
}

export async function applyMigrations(conn: Connection): Promise<void> {
  try {
    const currentVersion = await getCurrentVersion(conn);
    console.log(`当前数据库版本: v${currentVersion}`);

    const pendingMigrations = migrations.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      console.log('数据库已是最新版本（由 schema.ts 定义初始结构）');
      return;
    }

    console.log(`发现 ${pendingMigrations.length} 个待应用的迁移`);

    for (const migration of pendingMigrations) {
      await conn.beginTransaction();
      try {
        console.log(`应用迁移 v${migration.version}: ${migration.name}`);
        await migration.up(conn);

        await conn.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.name, Date.now()]
        );

        await conn.commit();
        console.log(`迁移 v${migration.version} 应用成功`);
      } catch (e: any) {
        await conn.rollback();
        console.error(`迁移 v${migration.version} 应用失败:`, e.message);
        console.error('错误详情:', e);
        throw e;
      }
    }

    console.log('所有迁移应用完成');
  } catch (e: any) {
    console.error('迁移系统执行失败:', e.message);
    throw e;
  }
}

export async function rollbackMigration(conn: Connection, targetVersion: number): Promise<void> {
  const currentVersion = await getCurrentVersion(conn);

  if (targetVersion >= currentVersion) {
    console.log('目标版本不低于当前版本，无需回滚');
    return;
  }

  const migrationsToRollback = migrations
    .filter(m => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of migrationsToRollback) {
    if (!migration.down) {
      console.warn(`迁移 v${migration.version} 没有回滚脚本，跳过`);
      continue;
    }

    try {
      console.log(`回滚迁移 v${migration.version}: ${migration.name}`);
      await migration.down(conn);

      await conn.query('DELETE FROM schema_migrations WHERE version = ?', [migration.version]);

      console.log(`迁移 v${migration.version} 回滚成功`);
    } catch (e) {
      console.error(`迁移 v${migration.version} 回滚失败:`, e);
      throw e;
    }
  }

  console.log('回滚完成');
}
