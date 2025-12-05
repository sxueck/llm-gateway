import { getDatabase } from './connection.js';

export async function createTables() {
  const pool = getDatabase();
  const conn = await pool.getConnection();

  try {
    // 用户表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
        updated_at BIGINT NOT NULL,
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 提供商表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        base_url TEXT NOT NULL,
        protocol_mappings TEXT,
        api_key TEXT NOT NULL,
        model_mapping TEXT,
        enabled TINYINT DEFAULT 1,
        created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
        updated_at BIGINT NOT NULL,
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 模型表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS models (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255),
        model_identifier VARCHAR(255) NOT NULL,
        protocol VARCHAR(50),
        is_virtual TINYINT DEFAULT 0,
        routing_config_id VARCHAR(255),
        expert_routing_id VARCHAR(255),
        enabled TINYINT DEFAULT 1,
        model_attributes TEXT,
        compression_config TEXT,
        created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
        INDEX idx_models_provider (provider_id),
        INDEX idx_models_enabled (enabled),
        INDEX idx_models_is_virtual (is_virtual),
        INDEX idx_models_routing_config (routing_config_id),
        INDEX idx_models_compression_config (compression_config(255)),
        INDEX idx_models_expert_routing (expert_routing_id),
        INDEX idx_models_protocol (protocol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 虚拟密钥表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS virtual_keys (
        id VARCHAR(255) PRIMARY KEY,
        key_value VARCHAR(255) NOT NULL UNIQUE,
        key_hash VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        provider_id VARCHAR(255),
        model_id VARCHAR(255),
        routing_strategy VARCHAR(50) DEFAULT 'single',
        model_ids TEXT,
        routing_config TEXT,
        enabled TINYINT DEFAULT 1,
        rate_limit INT,
        cache_enabled TINYINT DEFAULT 0,
        disable_logging TINYINT DEFAULT 0,
        dynamic_compression_enabled TINYINT DEFAULT 0,
        intercept_zero_temperature TINYINT DEFAULT 0,
        zero_temperature_replacement DECIMAL(3,2) DEFAULT NULL,
        created_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP() * 1000),
        updated_at BIGINT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
        FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL,
        INDEX idx_virtual_keys_hash (key_hash),
        INDEX idx_virtual_keys_value (key_value),
        INDEX idx_virtual_keys_provider (provider_id),
        INDEX idx_virtual_keys_model (model_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 系统配置表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        ` + "`key`" + ` VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // API 请求日志表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS api_requests (
        id VARCHAR(255) PRIMARY KEY,
        virtual_key_id VARCHAR(255),
        provider_id VARCHAR(255),
        model VARCHAR(255),
        prompt_tokens INT DEFAULT 0,
        completion_tokens INT DEFAULT 0,
        total_tokens INT AS (prompt_tokens + completion_tokens) STORED,
        cached_tokens INT DEFAULT 0,
        status VARCHAR(50),
        response_time INT,
        error_message TEXT,
        request_body MEDIUMTEXT,
        response_body MEDIUMTEXT,
        cache_hit TINYINT DEFAULT 0,
        request_type VARCHAR(50) DEFAULT 'chat',
        compression_original_tokens INT DEFAULT NULL,
        compression_saved_tokens INT DEFAULT NULL,
        created_at BIGINT NOT NULL,
        FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL,
        INDEX idx_api_requests_created_at (created_at),
        INDEX idx_api_requests_virtual_key (virtual_key_id),
        INDEX idx_api_requests_provider (provider_id),
        INDEX idx_api_requests_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 路由配置表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS routing_configs (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        type VARCHAR(50) NOT NULL,
        config TEXT NOT NULL,
        enabled TINYINT DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_type (type),
        INDEX idx_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 专家路由配置表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS expert_routing_configs (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        enabled TINYINT DEFAULT 1,
        config TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_expert_routing_configs_enabled (enabled),
        INDEX idx_expert_routing_configs_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 专家路由日志表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS expert_routing_logs (
        id VARCHAR(255) PRIMARY KEY,
        virtual_key_id VARCHAR(255),
        expert_routing_id VARCHAR(255) NOT NULL,
        request_hash VARCHAR(255) NOT NULL,
        classifier_model VARCHAR(255) NOT NULL,
        classification_result VARCHAR(255) NOT NULL,
        selected_expert_id VARCHAR(255) NOT NULL,
        selected_expert_type VARCHAR(50) NOT NULL,
        selected_expert_name VARCHAR(255) NOT NULL,
        classification_time INT,
        created_at BIGINT NOT NULL,
        original_request MEDIUMTEXT,
        classifier_request MEDIUMTEXT,
        classifier_response MEDIUMTEXT,
        FOREIGN KEY (virtual_key_id) REFERENCES virtual_keys(id) ON DELETE SET NULL,
        INDEX idx_expert_routing_logs_config (expert_routing_id),
        INDEX idx_expert_routing_logs_created_at (created_at),
        INDEX idx_expert_routing_logs_category (classification_result)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 健康检查目标表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS health_targets (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        display_title VARCHAR(255) DEFAULT NULL COMMENT '显示标题(可自定义)',
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

    // 健康检查运行记录表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS health_runs (
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

    // 健康检查汇总表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS health_summaries (
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

    // 成本映射规则表
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cost_mappings (
        id VARCHAR(255) PRIMARY KEY,
        pattern VARCHAR(255) NOT NULL,
        target_model VARCHAR(255) NOT NULL,
        priority INT DEFAULT 0,
        enabled TINYINT DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        INDEX idx_cost_mappings_pattern (pattern),
        INDEX idx_cost_mappings_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 熔断器触发统计表（持久化存储每个 Provider 的触发次数）
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
  } finally {
    conn.release();
  }
}
