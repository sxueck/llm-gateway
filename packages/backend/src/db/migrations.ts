import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

// 注意：schema.ts 中已经包含了全部当前需要的表结构和字段。
// 迁移脚本仅保留版本追踪骨架，方便未来新增迁移时扩展。
export const migrations: Migration[] = [
  {
    version: 16,
    name: 'add_backup_and_restore_tables',
    up: async (conn: Connection) => {
      // Create backup_records table
      await conn.query(`
        CREATE TABLE IF NOT EXISTS backup_records (
          id VARCHAR(255) PRIMARY KEY,
          backup_key VARCHAR(255) NOT NULL,
          backup_type ENUM('full', 'incremental') NOT NULL,
          includes_logs TINYINT DEFAULT 0,
          file_size BIGINT,
          file_hash VARCHAR(64),
          s3_key VARCHAR(500) NOT NULL,
          encryption_key_hash VARCHAR(64),
          status ENUM('pending', 'running', 'completed', 'failed') NOT NULL,
          started_at BIGINT,
          completed_at BIGINT,
          error_message TEXT,
          record_count INT,
          checksum VARCHAR(64),
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          INDEX idx_backup_records_status (status),
          INDEX idx_backup_records_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Create restore_records table
      await conn.query(`
        CREATE TABLE IF NOT EXISTS restore_records (
          id VARCHAR(255) PRIMARY KEY,
          backup_record_id VARCHAR(255) NOT NULL,
          restore_type ENUM('full', 'partial') NOT NULL,
          status ENUM('pending', 'running', 'completed', 'failed', 'rollback') NOT NULL,
          started_at BIGINT,
          completed_at BIGINT,
          error_message TEXT,
          backup_before_restore VARCHAR(255),
          changes_made JSON,
          rollback_data JSON,
          created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
          FOREIGN KEY (backup_record_id) REFERENCES backup_records(id) ON DELETE CASCADE,
          INDEX idx_restore_records_status (status),
          INDEX idx_restore_records_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS restore_records');
      await conn.query('DROP TABLE IF EXISTS backup_records');
    }
  },
  {
    version: 17,
    name: 'add_default_timestamps_and_generated_total_tokens',
    up: async (conn: Connection) => {
      // 使用 ALTER TABLE 为已有表补齐 created_at 默认值和 total_tokens 生成列
      const statements: string[] = [
        // 基础表
        `ALTER TABLE users MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE providers MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE models MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE virtual_keys MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE routing_configs MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE expert_routing_configs MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE expert_routing_logs MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE health_targets MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE health_runs MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE health_summaries MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        // 备份/恢复表
        `ALTER TABLE backup_records MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE restore_records MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        // api_requests: total_tokens 改为生成列 + created_at 默认值
        `ALTER TABLE api_requests MODIFY created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000)`,
        `ALTER TABLE api_requests MODIFY total_tokens INT AS (prompt_tokens + completion_tokens) STORED`
      ];

      for (const sql of statements) {
        try {
          await conn.query(sql);
        } catch (e: any) {
          console.warn('[迁移] 执行语句失败, 已跳过:', sql, e.message);
        }
      }
    }
  },
  {
    version: 18,
    name: 'remove_prompt_config_from_models',
    up: async (conn: Connection) => {
      // 删除 models 表中的 prompt_config 字段
      try {
        await conn.query(`ALTER TABLE models DROP COLUMN IF EXISTS prompt_config`);
        console.log('[迁移] 已删除 models 表的 prompt_config 字段');
      } catch (e: any) {
        console.warn('[迁移] 删除 prompt_config 字段失败, 已跳过:', e.message);
      }
    },
    down: async (conn: Connection) => {
      // 回滚时重新添加 prompt_config 字段
      try {
        await conn.query(`ALTER TABLE models ADD COLUMN prompt_config TEXT DEFAULT NULL AFTER model_attributes`);
        console.log('[迁移] 已恢复 models 表的 prompt_config 字段');
      } catch (e: any) {
        console.warn('[迁移] 恢复 prompt_config 字段失败:', e.message);
      }
    }
  },
  {
    version: 19,
    name: 'add_ip_to_api_requests',
    up: async (conn: Connection) => {
      try {
        await conn.query(`ALTER TABLE api_requests ADD COLUMN ip VARCHAR(45) DEFAULT NULL AFTER compression_saved_tokens`);
        console.log('[迁移] 已添加 api_requests 表的 ip 字段');
      } catch (e: any) {
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log('[迁移] api_requests 表已存在 ip 字段，跳过');
        } else {
          throw e;
        }
      }
    },
    down: async (conn: Connection) => {
      try {
        await conn.query(`ALTER TABLE api_requests DROP COLUMN IF EXISTS ip`);
        console.log('[迁移] 已删除 api_requests 表的 ip 字段');
      } catch (e: any) {
      console.warn('[迁移] 删除 ip 字段失败:', e.message);
    }
  }
  },
  {
    version: 20,
    name: 'add_user_agent_and_blocked_ips',
    up: async (conn: Connection) => {
      try {
        await conn.query(`ALTER TABLE api_requests ADD COLUMN user_agent VARCHAR(500) DEFAULT NULL AFTER ip`);
        console.log('[迁移] 已为 api_requests 表添加 user_agent 字段');
      } catch (e: any) {
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log('[迁移] api_requests 表已存在 user_agent 字段，跳过');
        } else {
          throw e;
        }
      }
    },
    down: async (conn: Connection) => {
      try {
        await conn.query(`ALTER TABLE api_requests DROP COLUMN IF EXISTS user_agent`);
        console.log('[迁移] 已删除 api_requests 表的 user_agent 字段');
      } catch (e: any) {
        console.warn('[迁移] 删除 user_agent 字段失败:', e.message);
      }
    },
  },
  {
    version: 21,
    name: 'add_circuit_breaker_stats_tables',
    up: async (conn: Connection) => {
      // 熔断器触发统计表
      await conn.query(`
        CREATE TABLE IF NOT EXISTS circuit_breaker_stats (
          provider_id VARCHAR(255) PRIMARY KEY,
          trigger_count INT NOT NULL DEFAULT 0,
          last_trigger_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          INDEX idx_circuit_breaker_trigger_count (trigger_count)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // 熔断器触发事件表
      await conn.query(`
        CREATE TABLE IF NOT EXISTS circuit_breaker_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          provider_id VARCHAR(255) NOT NULL,
          triggered_at BIGINT NOT NULL,
          INDEX idx_circuit_breaker_events_provider (provider_id),
          INDEX idx_circuit_breaker_events_time (triggered_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      
      console.log('[迁移] 已创建熔断器统计相关表 (circuit_breaker_stats, circuit_breaker_events)');
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS circuit_breaker_events');
      await conn.query('DROP TABLE IF EXISTS circuit_breaker_stats');
      console.log('[迁移] 已删除熔断器统计相关表');
    }
  },
  {
    version: 22,
    name: 'add_expert_routing_stats_fields',
    up: async (conn: Connection) => {
      try {
        await conn.query(`
          ALTER TABLE expert_routing_logs
          ADD COLUMN route_source VARCHAR(50) DEFAULT NULL COMMENT 'l1_semantic, l2_heuristic, l3_llm, fallback',
          ADD COLUMN prompt_tokens INT DEFAULT 0 COMMENT '原始请求预估Token',
          ADD COLUMN cleaned_content_length INT DEFAULT 0 COMMENT '清洗后用于分类的文本长度',
          ADD COLUMN semantic_score DECIMAL(5, 4) DEFAULT NULL COMMENT 'L1语义匹配分数'
        `);
        console.log('[迁移] 已为 expert_routing_logs 添加统计字段');
      } catch (e: any) {
        if (e.code === 'ER_DUP_FIELDNAME') {
          console.log('[迁移] expert_routing_logs 字段已存在，跳过');
        } else {
          throw e;
        }
      }
    },
    down: async (conn: Connection) => {
      try {
        await conn.query(`
          ALTER TABLE expert_routing_logs
          DROP COLUMN route_source,
          DROP COLUMN prompt_tokens,
          DROP COLUMN cleaned_content_length,
          DROP COLUMN semantic_score
        `);
      } catch (e: any) {
        console.warn('[迁移] 回滚 expert_routing_logs 字段失败:', e.message);
      }
    }
  },
  {
    version: 23,
    name: 'repair_expert_routing_stats_fields',
    up: async (conn: Connection) => {
      // v22 used a single ALTER TABLE with multiple ADD COLUMN.
      // If ANY one column already existed, MySQL throws ER_DUP_FIELDNAME and the rest are not applied.
      // Some deployments can end up with schema_migrations=v22 but missing prompt_tokens/cleaned_content_length/semantic_score.
      const hasColumn = async (col: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'expert_routing_logs'
             AND COLUMN_NAME = ?`,
          [col]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      const addColumnIfMissing = async (col: string, sql: string) => {
        if (await hasColumn(col)) return;
        try {
          await conn.query(sql);
          console.log(`[迁移] 已补齐 expert_routing_logs.${col}`);
        } catch (e: any) {
          if (e.code === 'ER_DUP_FIELDNAME') return;
          throw e;
        }
      };

      await addColumnIfMissing(
        'route_source',
        `ALTER TABLE expert_routing_logs ADD COLUMN route_source VARCHAR(50) DEFAULT NULL COMMENT 'l1_semantic, l2_heuristic, l3_llm, fallback'`
      );
      await addColumnIfMissing(
        'prompt_tokens',
        `ALTER TABLE expert_routing_logs ADD COLUMN prompt_tokens INT DEFAULT 0 COMMENT '原始请求预估Token'`
      );
      await addColumnIfMissing(
        'cleaned_content_length',
        `ALTER TABLE expert_routing_logs ADD COLUMN cleaned_content_length INT DEFAULT 0 COMMENT '清洗后用于分类的文本长度'`
      );
      await addColumnIfMissing(
        'semantic_score',
        `ALTER TABLE expert_routing_logs ADD COLUMN semantic_score DECIMAL(5, 4) DEFAULT NULL COMMENT 'L1语义匹配分数'`
      );
    },
  },
  {
    version: 24,
    name: 'cleanup_l1_semantic_fields',
    up: async (conn: Connection) => {
      // 清理 L1 语义路由相关字段
      // 1. 删除 semantic_score 字段（L1 语义匹配分数，已废弃）
      try {
        await conn.query(`ALTER TABLE expert_routing_logs DROP COLUMN IF EXISTS semantic_score`);
        console.log('[迁移] 已删除 expert_routing_logs.semantic_score 字段');
      } catch (e: any) {
        console.warn('[迁移] 删除 semantic_score 字段失败或不存在:', e.message);
      }

      // 2. 更新 route_source 字段注释，移除 L1/L2/L3 层级概念
      try {
        await conn.query(`
          ALTER TABLE expert_routing_logs
          MODIFY COLUMN route_source VARCHAR(50) DEFAULT NULL
          COMMENT '分类来源: llm, fallback'
        `);
        console.log('[迁移] 已更新 route_source 字段注释');
      } catch (e: any) {
        console.warn('[迁移] 更新 route_source 字段注释失败:', e.message);
      }
    },
    down: async (conn: Connection) => {
      // 回滚时恢复 L1 字段
      try {
        await conn.query(`
          ALTER TABLE expert_routing_logs
          ADD COLUMN semantic_score DECIMAL(5, 4) DEFAULT NULL COMMENT 'L1语义匹配分数'
        `);
        console.log('[迁移] 已恢复 expert_routing_logs.semantic_score 字段');
      } catch (e: any) {
        console.warn('[迁移] 恢复 semantic_score 字段失败:', e.message);
      }

      try {
        await conn.query(`
          ALTER TABLE expert_routing_logs
          MODIFY COLUMN route_source VARCHAR(50) DEFAULT NULL
          COMMENT 'l1_semantic, l2_heuristic, l3_llm, fallback'
        `);
        console.log('[迁移] 已恢复 route_source 字段注释');
      } catch (e: any) {
        console.warn('[迁移] 恢复 route_source 字段注释失败:', e.message);
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
