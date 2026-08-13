import type { Connection } from 'mysql2/promise';

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
  down?: (conn: Connection) => Promise<void>;
}

const legacyExpertRoutingLabels: Record<string, string> = {
  debug: 'code_repair',
  explain: 'code_explanation',
  feature: 'code_authoring',
  plan: 'architecture_consultation',
  refactor: 'code_modification',
  review: 'code_review',
  setup: 'dependency_management',
  test: 'test_generation',
  utility: 'general_inquiry',
  other: 'general_inquiry',
};

export function normalizeExpertRoutingConfig(configText: string): { config: string; changed: boolean } {
  const config = JSON.parse(configText);
  let changed = false;

  if (Array.isArray(config?.experts)) {
    for (const expert of config.experts) {
      const label = legacyExpertRoutingLabels[expert?.category];
      if (label) {
        expert.category = label;
        changed = true;
      }
      if (expert && 'system_prompt' in expert) {
        delete expert.system_prompt;
        changed = true;
      }
    }
  }

  if (config?.llm_second_pass) {
    for (const field of ['prompt_template', 'system_prompt', 'user_prompt_marker']) {
      if (field in config.llm_second_pass) {
        delete config.llm_second_pass[field];
        changed = true;
      }
    }
  }

  return { config: JSON.stringify(config), changed };
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
  },
  {
    version: 33,
    name: 'replace_model_protocol_with_supported_protocols',
    up: async (conn: Connection) => {
      const hasColumn = async (columnName: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'models'
             AND COLUMN_NAME = ?`,
          [columnName]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      const hasIndex = async (indexName: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'models'
             AND INDEX_NAME = ?`,
          [indexName]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      if (!(await hasColumn('supported_protocols'))) {
        await conn.query(`ALTER TABLE models ADD COLUMN supported_protocols TEXT`);
        console.log('[迁移] 已添加 models.supported_protocols 字段');
      }

      if (!(await hasColumn('health_check_protocol'))) {
        await conn.query(`ALTER TABLE models ADD COLUMN health_check_protocol VARCHAR(50)`);
        console.log('[迁移] 已添加 models.health_check_protocol 字段');
      }

      if (await hasColumn('protocol')) {
        // Migrate existing protocol values into supported_protocols JSON array
        await conn.query(`
          UPDATE models
          SET supported_protocols = CASE
            WHEN protocol IS NULL OR protocol = '' THEN '["openai"]'
            ELSE CONCAT('["', protocol, '"]')
          END,
          health_check_protocol = CASE
            WHEN protocol IS NULL OR protocol = '' THEN 'openai'
            ELSE protocol
          END
        `);
        console.log('[迁移] 已迁移 models.protocol 到 supported_protocols 和 health_check_protocol');

        if (await hasIndex('idx_models_protocol')) {
          await conn.query(`DROP INDEX idx_models_protocol ON models`);
          console.log('[迁移] 已删除 idx_models_protocol 索引');
        }

        await conn.query(`ALTER TABLE models DROP COLUMN protocol`);
        console.log('[迁移] 已删除 models.protocol 字段');
      } else {
        // Backfill defaults when protocol column is already absent (partial/fresh state)
        await conn.query(`
          UPDATE models
          SET supported_protocols = '["openai"]'
          WHERE supported_protocols IS NULL OR supported_protocols = ''
        `);
        await conn.query(`
          UPDATE models
          SET health_check_protocol = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(supported_protocols, '$[0]')), 'openai')
          WHERE health_check_protocol IS NULL OR health_check_protocol = ''
        `);
        console.log('[迁移] 已回填 models.supported_protocols 和 health_check_protocol 默认值');
      }
    },
    down: async (conn: Connection) => {
      const hasColumn = async (columnName: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'models'
             AND COLUMN_NAME = ?`,
          [columnName]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      const hasIndex = async (indexName: string) => {
        const [rows] = await conn.query(
          `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'models'
             AND INDEX_NAME = ?`,
          [indexName]
        );
        const result = rows as any[];
        return Number(result?.[0]?.cnt || 0) > 0;
      };

      if (!(await hasColumn('protocol'))) {
        await conn.query(`ALTER TABLE models ADD COLUMN protocol VARCHAR(50)`);
        console.log('[迁移] 已恢复 models.protocol 字段');
      }

      // Backfill protocol from the first entry of supported_protocols
      await conn.query(`
        UPDATE models
        SET protocol = CASE
          WHEN supported_protocols IS NULL OR supported_protocols = '' THEN 'openai'
          ELSE JSON_UNQUOTE(JSON_EXTRACT(supported_protocols, '$[0]'))
        END
      `);
      console.log('[迁移] 已从 supported_protocols 回填充 protocol 字段');

      if (!(await hasIndex('idx_models_protocol'))) {
        await conn.query(`CREATE INDEX idx_models_protocol ON models(protocol)`);
        console.log('[迁移] 已重建 idx_models_protocol 索引');
      }

      if (await hasColumn('supported_protocols')) {
        await conn.query(`ALTER TABLE models DROP COLUMN supported_protocols`);
      }
      if (await hasColumn('health_check_protocol')) {
        await conn.query(`ALTER TABLE models DROP COLUMN health_check_protocol`);
      }
      console.log('[迁移] 已删除 supported_protocols 和 health_check_protocol 字段');
    }
  },
  {
    version: 34,
    name: 'local_onnx_expert_routing_reset',
    up: async (conn: Connection) => {
      // 1. Durable session bindings table (idempotent with schema.ts).
      await conn.query(`
        CREATE TABLE IF NOT EXISTS expert_routing_session_bindings (
          expert_routing_id VARCHAR(255) NOT NULL,
          virtual_key_scope VARCHAR(255) NOT NULL,
          session_id VARCHAR(256) NOT NULL,
          expert_id VARCHAR(255) NOT NULL,
          route_source VARCHAR(50) NOT NULL,
          created_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          idle_expires_at BIGINT NOT NULL,
          absolute_expires_at BIGINT NOT NULL,
          PRIMARY KEY (expert_routing_id, virtual_key_scope, session_id),
          INDEX idx_bindings_idle_expires (idle_expires_at),
          INDEX idx_bindings_absolute_expires (absolute_expires_at),
          INDEX idx_bindings_expert (expert_routing_id, expert_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[迁移] 已确保 expert_routing_session_bindings 表存在');

      // 2. Destructive reset of legacy LLM-primary Expert Routing data (AC-7, FR-12).
      //    The local-ONNX classifier config is incompatible with the legacy
      //    `classifier`-based configs, so all prior configs/logs/generated models
      //    are removed. This is a one-time, intentional, irreversible migration.

      // 2a. Detach (non-generated) models that referenced legacy configs, then
      //     drop the generated virtual models (model_identifier = expert-<configId>).
      await conn.query(`
        UPDATE models
        SET expert_routing_id = NULL
        WHERE expert_routing_id IS NOT NULL
      `);
      console.log('[迁移] 已解绑所有引用旧专家路由配置的模型');

      await conn.query(`
        DELETE FROM models
        WHERE is_virtual = 1 AND model_identifier LIKE 'expert-%'
      `);
      console.log('[迁移] 已删除旧专家路由生成的虚拟模型');

      // 2b. Remove legacy Expert Routing logs and configs.
      await conn.query(`DELETE FROM expert_routing_logs`);
      console.log('[迁移] 已清空旧专家路由日志');

      await conn.query(`DELETE FROM expert_routing_configs`);
      console.log('[迁移] 已清空旧专家路由配置');

      // 2c. Drop any pre-existing session bindings table from earlier iterations.
      await conn.query(`DROP TABLE IF EXISTS expert_routing_session_bindings_legacy`);
      console.log('[迁移] 本地 ONNX 专家路由重置完成');
    }
  },
  {
    version: 35,
    name: 'add_expert_routing_training_records',
    up: async (conn: Connection) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS expert_routing_training_records (
          id VARCHAR(255) PRIMARY KEY,
          expert_routing_id VARCHAR(255) NOT NULL,
          input_hash CHAR(64) NOT NULL,
          input_text MEDIUMTEXT NOT NULL,
          local_result JSON DEFAULT NULL,
          classifier_revision VARCHAR(255) DEFAULT NULL,
          judge_prompt_version VARCHAR(100) NOT NULL,
          judge_model VARCHAR(255) DEFAULT NULL,
          judge_intent_label VARCHAR(255) NOT NULL,
          judge_confidence DECIMAL(5,4) NOT NULL,
          judge_reason TEXT DEFAULT NULL,
          final_intent_label VARCHAR(255) NOT NULL,
          final_expert_id VARCHAR(255) DEFAULT NULL,
          status ENUM('pending_review', 'accepted', 'rejected') NOT NULL DEFAULT 'pending_review',
          occurrence_count INT NOT NULL DEFAULT 1,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          reviewed_at BIGINT DEFAULT NULL,
          UNIQUE KEY uk_training_record_input (expert_routing_id, input_hash),
          INDEX idx_training_records_status (expert_routing_id, status, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      console.log('[迁移] 已创建 expert_routing_training_records 表');
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS expert_routing_training_records');
      console.log('[迁移] 已删除 expert_routing_training_records 表');
    }
  },
  {
    version: 36,
    name: 'normalize_expert_routing_labels_and_prompt_config',
    up: async (conn: Connection) => {
      const [rows] = await conn.query('SELECT id, config FROM expert_routing_configs');
      let updated = 0;

      for (const row of rows as Array<{ id: string; config: string }>) {
        try {
          const normalized = normalizeExpertRoutingConfig(row.config);
          if (!normalized.changed) continue;
          await conn.query(
            'UPDATE expert_routing_configs SET config = ?, updated_at = ? WHERE id = ?',
            [normalized.config, Date.now(), row.id]
          );
          updated += 1;
        } catch (error: any) {
          console.warn(`[迁移] 跳过无法解析的专家路由配置 ${row.id}: ${error.message}`);
        }
      }

      console.log(`[迁移] 已规范化 ${updated} 个专家路由配置`);
    }
  },
  {
    version: 37,
    name: 'add_prompt_capture_samples',
    up: async (conn: Connection) => {
      const [columns] = await conn.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'virtual_keys'
          AND COLUMN_NAME = 'prompt_capture_enabled'
      `);
      if ((columns as any[]).length === 0) {
        await conn.query('ALTER TABLE virtual_keys ADD COLUMN prompt_capture_enabled TINYINT DEFAULT 0');
      }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS prompt_samples (
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
    },
    down: async (conn: Connection) => {
      await conn.query('DROP TABLE IF EXISTS prompt_samples');
      await conn.query('ALTER TABLE virtual_keys DROP COLUMN IF EXISTS prompt_capture_enabled');
    }
  },
  {
    version: 38,
    name: 'add_circuit_breaker_fk_cascade',
    up: async (conn: Connection) => {
      if (!(await hasProviderForeignKey(conn, 'circuit_breaker_stats', 'provider_id'))) {
        // 清理已删除供应商的残留统计记录
        await conn.query(`
          DELETE FROM circuit_breaker_stats
          WHERE provider_id NOT IN (SELECT id FROM providers)
        `);
        await conn.query(`
          ALTER TABLE circuit_breaker_stats
          ADD CONSTRAINT fk_circuit_breaker_stats_provider
          FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
        `);
        console.log('[迁移] 已添加 circuit_breaker_stats.provider_id FK (ON DELETE CASCADE)');
      }

      if (!(await hasProviderForeignKey(conn, 'circuit_breaker_events', 'provider_id'))) {
        // 清理已删除供应商的残留事件记录
        await conn.query(`
          DELETE FROM circuit_breaker_events
          WHERE provider_id NOT IN (SELECT id FROM providers)
        `);
        await conn.query(`
          ALTER TABLE circuit_breaker_events
          ADD CONSTRAINT fk_circuit_breaker_events_provider
          FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
        `);
        console.log('[迁移] 已添加 circuit_breaker_events.provider_id FK (ON DELETE CASCADE)');
      }
    },
    down: async (conn: Connection) => {
      const fkStats = await getProviderForeignKeyName(conn, 'circuit_breaker_stats', 'provider_id');
      if (fkStats) {
        await conn.query(`ALTER TABLE circuit_breaker_stats DROP FOREIGN KEY \`${fkStats}\``);
        console.log('[迁移] 已删除 circuit_breaker_stats FK');
      }

      const fkEvents = await getProviderForeignKeyName(conn, 'circuit_breaker_events', 'provider_id');
      if (fkEvents) {
        await conn.query(`ALTER TABLE circuit_breaker_events DROP FOREIGN KEY \`${fkEvents}\``);
        console.log('[迁移] 已删除 circuit_breaker_events FK');
      }
    }
  }
];

async function hasProviderForeignKey(conn: Connection, tableName: string, columnName: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
       AND REFERENCED_TABLE_NAME = 'providers'`,
    [tableName, columnName]
  );
  const result = rows as any[];
  return Number(result?.[0]?.cnt || 0) > 0;
}

async function getProviderForeignKeyName(conn: Connection, tableName: string, columnName: string): Promise<string | null> {
  const [rows] = await conn.query(
    `SELECT CONSTRAINT_NAME
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
       AND REFERENCED_TABLE_NAME = 'providers'
     LIMIT 1`,
    [tableName, columnName]
  );
  const result = rows as any[];
  return result?.[0]?.CONSTRAINT_NAME || null;
}

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
