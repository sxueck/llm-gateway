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
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'virtual_keys'
        AND COLUMN_NAME = 'dynamic_compression_enabled'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 virtual_keys.dynamic_compression_enabled 字段');
        await conn.query(`
          ALTER TABLE virtual_keys
          DROP COLUMN dynamic_compression_enabled
        `);
      } else {
        console.log('  - 回滚: dynamic_compression_enabled 字段不存在,跳过');
      }
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
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_requests'
        AND COLUMN_NAME = 'compression_original_tokens'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 api_requests 压缩统计字段');
        await conn.query(`
          ALTER TABLE api_requests
          DROP COLUMN compression_original_tokens,
          DROP COLUMN compression_saved_tokens
        `);
      } else {
        console.log('  - 回滚: 压缩统计字段不存在,跳过');
      }
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
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'virtual_keys'
        AND COLUMN_NAME = 'intercept_zero_temperature'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 virtual_keys.intercept_zero_temperature 和 zero_temperature_replacement 字段');
        await conn.query(`
          ALTER TABLE virtual_keys
          DROP COLUMN intercept_zero_temperature,
          DROP COLUMN zero_temperature_replacement
        `);
      } else {
        console.log('  - 回滚: intercept_zero_temperature 字段不存在,跳过');
      }
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
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'models'
        AND COLUMN_NAME = 'protocol'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 models.protocol 字段');
        await conn.query(`
          ALTER TABLE models
          DROP COLUMN protocol
        `);
      } else {
        console.log('  - 回滚: protocol 字段不存在,跳过');
      }
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
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'providers'
        AND COLUMN_NAME = 'protocol_mappings'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 providers.protocol_mappings 字段');
        await conn.query(`
          ALTER TABLE providers
          DROP COLUMN protocol_mappings
        `);
      } else {
        console.log('  - 回滚: protocol_mappings 字段不存在,跳过');
      }
    },
  },
  {
    version: 10,
    name: 'extend_api_requests_body_fields_to_mediumtext',
    up: async (conn: Connection) => {
      try {
        const [tables] = await conn.query(`
          SELECT COLUMN_TYPE
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'api_requests'
          AND COLUMN_NAME = 'request_body'
        `);
        const result = tables as any[];

        if (result.length > 0 && result[0].COLUMN_TYPE !== 'mediumtext') {
          console.log('  - 扩展 api_requests.request_body 和 response_body 为 MEDIUMTEXT');
          await conn.query(`
            ALTER TABLE api_requests
            MODIFY COLUMN request_body MEDIUMTEXT,
            MODIFY COLUMN response_body MEDIUMTEXT
          `);
        } else if (result.length > 0) {
          console.log('  - api_requests body 字段已是 MEDIUMTEXT,跳过');
        } else {
          console.log('  - api_requests 表不存在或字段不存在,跳过');
        }
      } catch (e: any) {
        console.error('  - 迁移 v10 执行出错:', e.message);
        throw e;
      }
    },
    down: async (conn: Connection) => {
      await conn.query(`
        ALTER TABLE api_requests
        MODIFY COLUMN request_body MEDIUMTEXT,
        MODIFY COLUMN response_body MEDIUMTEXT
      `);
    },
  },
  {
    version: 11,
    name: 'add_description_to_providers',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'providers'
        AND COLUMN_NAME = 'description'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 providers.description 字段');
        await conn.query(`
          ALTER TABLE providers
          ADD COLUMN description TEXT DEFAULT NULL AFTER name
        `);
      } else {
        console.log('  - providers.description 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'providers'
        AND COLUMN_NAME = 'description'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 providers.description 字段');
        await conn.query(`ALTER TABLE providers DROP COLUMN description`);
      } else {
        console.log('  - 回滚: description 字段不存在,跳过');
      }
    },
  },
  {
    version: 12,
    name: 'add_cached_tokens_to_api_requests',
    up: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_requests'
        AND COLUMN_NAME = 'cached_tokens'
      `);
      const result = tables as any[];

      if (result[0].count === 0) {
        console.log('  - 添加 api_requests.cached_tokens 字段');
        await conn.query(`
          ALTER TABLE api_requests
          ADD COLUMN cached_tokens INT DEFAULT 0 AFTER total_tokens
        `);
      } else {
        console.log('  - api_requests.cached_tokens 字段已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      const [tables] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'api_requests'
        AND COLUMN_NAME = 'cached_tokens'
      `);
      const result = tables as any[];

      if (result[0].count > 0) {
        console.log('  - 回滚: 移除 api_requests.cached_tokens 字段');
        await conn.query(`
          ALTER TABLE api_requests
          DROP COLUMN cached_tokens
        `);
      } else {
        console.log('  - 回滚: cached_tokens 字段不存在,跳过');
      }
    },
  },
  {
    version: 13,
    name: 'create_health_monitoring_tables',
    up: async (conn: Connection) => {
      // 创建 health_targets 表
      const [healthTargets] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'health_targets'
      `);
      const healthTargetsExists = (healthTargets as any[])[0].count > 0;

      if (!healthTargetsExists) {
        console.log('  - 创建 health_targets 表');
        await conn.query(`
          CREATE TABLE health_targets (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            type ENUM('model', 'virtual_model') NOT NULL,
            target_id VARCHAR(255) NOT NULL COMMENT '模型或虚拟模型的ID',
            enabled TINYINT DEFAULT 1,
            check_interval_seconds INT DEFAULT 300 COMMENT '检查频率(秒)',
            check_prompt TEXT DEFAULT NULL COMMENT '健康检查使用的提示词',
            check_config TEXT DEFAULT NULL COMMENT 'JSON配置: 超时、重试、并发等',
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            INDEX idx_health_targets_type (type),
            INDEX idx_health_targets_enabled (enabled),
            INDEX idx_health_targets_target_id (target_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } else {
        console.log('  - health_targets 表已存在,跳过');
      }

      // 创建 health_runs 表
      const [healthRuns] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'health_runs'
      `);
      const healthRunsExists = (healthRuns as any[])[0].count > 0;

      if (!healthRunsExists) {
        console.log('  - 创建 health_runs 表');
        await conn.query(`
          CREATE TABLE health_runs (
            id VARCHAR(255) PRIMARY KEY,
            target_id VARCHAR(255) NOT NULL,
            status ENUM('success', 'error') NOT NULL,
            latency_ms INT NOT NULL COMMENT '总耗时(毫秒)',
            error_type VARCHAR(100) DEFAULT NULL COMMENT '错误类型',
            error_message TEXT DEFAULT NULL COMMENT '错误摘要',
            request_id VARCHAR(255) DEFAULT NULL COMMENT '请求ID,对齐api_requests',
            created_at BIGINT NOT NULL,
            FOREIGN KEY (target_id) REFERENCES health_targets(id) ON DELETE CASCADE,
            INDEX idx_health_runs_target (target_id),
            INDEX idx_health_runs_created_at (created_at),
            INDEX idx_health_runs_status (status)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } else {
        console.log('  - health_runs 表已存在,跳过');
      }

      // 创建 health_summaries 表 (可选,MVP阶段可以不创建)
      const [healthSummaries] = await conn.query(`
        SELECT COUNT(*) as count
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'health_summaries'
      `);
      const healthSummariesExists = (healthSummaries as any[])[0].count > 0;

      if (!healthSummariesExists) {
        console.log('  - 创建 health_summaries 表');
        await conn.query(`
          CREATE TABLE health_summaries (
            id VARCHAR(255) PRIMARY KEY,
            target_id VARCHAR(255) NOT NULL,
            window_start BIGINT NOT NULL COMMENT '时间窗口起点',
            window_end BIGINT NOT NULL COMMENT '时间窗口终点',
            total_checks INT DEFAULT 0,
            success_count INT DEFAULT 0,
            error_count INT DEFAULT 0,
            avg_latency_ms INT DEFAULT 0,
            p50_latency_ms INT DEFAULT 0,
            p95_latency_ms INT DEFAULT 0,
            p99_latency_ms INT DEFAULT 0,
            created_at BIGINT NOT NULL,
            FOREIGN KEY (target_id) REFERENCES health_targets(id) ON DELETE CASCADE,
            INDEX idx_health_summaries_target (target_id),
            INDEX idx_health_summaries_window (window_start, window_end)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      } else {
        console.log('  - health_summaries 表已存在,跳过');
      }
    },
    down: async (conn: Connection) => {
      console.log('  - 回滚: 删除健康检查相关表');
      await conn.query('DROP TABLE IF EXISTS health_summaries');
      await conn.query('DROP TABLE IF EXISTS health_runs');
      await conn.query('DROP TABLE IF EXISTS health_targets');
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
