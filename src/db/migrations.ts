import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'extend_expert_routing_logs_text_fields',
    up: async (conn: Connection) => {
      try {
        const [tables] = await conn.query(`
          SELECT COLUMN_TYPE
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'expert_routing_logs'
          AND COLUMN_NAME = 'original_request'
        `);
        const result = tables as any[];

        if (result.length > 0 && result[0].COLUMN_TYPE !== 'mediumtext') {
          console.log('  - 扩展 expert_routing_logs 文本字段为 MEDIUMTEXT');
          await conn.query(`
            ALTER TABLE expert_routing_logs
            MODIFY COLUMN original_request MEDIUMTEXT,
            MODIFY COLUMN classifier_request MEDIUMTEXT,
            MODIFY COLUMN classifier_response MEDIUMTEXT
          `);
        } else if (result.length > 0) {
          console.log('  - expert_routing_logs 文本字段已是 MEDIUMTEXT,跳过');
        } else {
          console.log('  - expert_routing_logs 表不存在或字段不存在,跳过');
        }
      } catch (e: any) {
        console.error('  - 迁移 v1 执行出错:', e.message);
        throw e;
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE expert_routing_logs
        MODIFY COLUMN original_request TEXT,
        MODIFY COLUMN classifier_request TEXT,
        MODIFY COLUMN classifier_response TEXT
      `);
    },
  },
  {
    version: 2,
    name: 'remove_prompt_cache_fields',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_requests'
        AND COLUMN_NAME = 'prompt_cache_hit_tokens'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 移除 api_requests 的 prompt_cache 相关字段');
        await conn.query(`
          ALTER TABLE api_requests
          DROP COLUMN prompt_cache_hit_tokens,
          DROP COLUMN prompt_cache_write_tokens
        `);
      } else {
        console.log('  - prompt_cache 字段不存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE api_requests
        ADD COLUMN prompt_cache_hit_tokens INT DEFAULT 0,
        ADD COLUMN prompt_cache_write_tokens INT DEFAULT 0
      `);
    },
  },
  {
    version: 4,
    name: 'add_dynamic_compression_to_virtual_keys',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'virtual_keys'
        AND COLUMN_NAME = 'dynamic_compression_enabled'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 virtual_keys.dynamic_compression_enabled 字段');
        await conn.query(`
          ALTER TABLE virtual_keys
          ADD COLUMN dynamic_compression_enabled TINYINT DEFAULT 0 AFTER disable_logging
        `);
      } else {
        console.log('  - virtual_keys.dynamic_compression_enabled 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE virtual_keys
        DROP COLUMN dynamic_compression_enabled
      `);
    },
  },
  {
    version: 5,
    name: 'add_compression_stats_to_api_requests',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_requests'
        AND COLUMN_NAME = 'compression_original_tokens'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 api_requests 压缩统计字段');
        await conn.query(`
          ALTER TABLE api_requests
          ADD COLUMN compression_original_tokens INT DEFAULT NULL AFTER request_type,
          ADD COLUMN compression_saved_tokens INT DEFAULT NULL AFTER compression_original_tokens
        `);
      } else {
        console.log('  - api_requests 压缩统计字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE api_requests
        DROP COLUMN compression_original_tokens,
        DROP COLUMN compression_saved_tokens
      `);
    },
  },
  {
    version: 6,
    name: 'add_full_request_logging_to_api_requests',
    up: async (conn: Connection) => {
      // 该迁移已在数据库中应用，保留定义以保持版本一致性
      console.log('  - 跳过已应用的迁移 v6');
    },
    down: async (conn: Connection) => {
      // 回滚操作（如果需要）
    },
  },
  {
    version: 7,
    name: 'add_intercept_zero_temperature_to_virtual_keys',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'virtual_keys'
          AND COLUMN_NAME = 'intercept_zero_temperature'
        `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 virtual_keys.intercept_zero_temperature 和 zero_temperature_replacement 字段');
        await conn.query(`
          ALTER TABLE virtual_keys
          ADD COLUMN intercept_zero_temperature TINYINT DEFAULT 0 AFTER dynamic_compression_enabled,
          ADD COLUMN zero_temperature_replacement DECIMAL(3,2) DEFAULT NULL AFTER intercept_zero_temperature
        `);
      } else {
        console.log('  - virtual_keys.intercept_zero_temperature 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE virtual_keys
        DROP COLUMN intercept_zero_temperature,
        DROP COLUMN zero_temperature_replacement
      `);
    },
  },
  {
    version: 8,
    name: 'add_protocol_to_models',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'models'
        AND COLUMN_NAME = 'protocol'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 models.protocol 字段');
        await conn.query(`
          ALTER TABLE models
          ADD COLUMN protocol VARCHAR(20) DEFAULT NULL AFTER model_identifier
        `);
      } else {
        console.log('  - models.protocol 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE models
        DROP COLUMN protocol
      `);
    },
  },
  {
    version: 9,
    name: 'add_protocol_mappings_to_providers',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'providers'
        AND COLUMN_NAME = 'protocol_mappings'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 providers.protocol_mappings 字段');
        await conn.query(`
          ALTER TABLE providers
          ADD COLUMN protocol_mappings TEXT DEFAULT NULL AFTER base_url
        `);
      } else {
        console.log('  - providers.protocol_mappings 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE providers
        DROP COLUMN protocol_mappings
      `);
    },
  },
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
      console.log('数据库已是最新版本');
      return;
    }

    console.log(`发现 ${pendingMigrations.length} 个待应用的迁移`);

    for (const migration of pendingMigrations) {
      // 每个迁移在独立的事务中执行
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
