import type { Connection } from 'mysql2/promise';
import { describe, expect, test, vi } from 'vitest';
import { applyMigrations, migrations, normalizeExpertRoutingConfig, transformExpertRoutingConfigV2 } from './migrations.js';

describe('migration runner from v45', () => {
  test('has unique migration versions and applies v47/v48/v49/v50/v51 after v45', async () => {
    const versions = migrations.map(migration => migration.version);
    expect(new Set(versions).size).toBe(versions.length);

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('MAX(version)')) return [[{ version: 45 }]];
      if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [[{ cnt: 0 }]];
      if (sql.includes('IS_NULLABLE AS is_nullable')) return [[{ is_nullable: 'NO' }]];
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [[{ cnt: 0 }]];
      return [[]];
    });
    const conn = {
      query,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
    } as unknown as Connection;

    await applyMigrations(conn);

    // v47 adds the expert-routing difficulty columns idempotently.
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE expert_routing_logs ADD COLUMN difficulty VARCHAR(16) DEFAULT NULL COMMENT '路由难度: low/medium/high'",
    );
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE expert_routing_session_bindings ADD COLUMN difficulty VARCHAR(16) DEFAULT NULL COMMENT '绑定时的路由难度(可选)'",
    );
    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE expert_routing_logs MODIFY COLUMN classifier_model VARCHAR(255) DEFAULT NULL',
    );
    // v47 also carries the unreleased agent run correlation additions.
    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE api_requests ADD COLUMN run_id VARCHAR(255) DEFAULT NULL',
    );
    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE api_requests ADD INDEX idx_api_requests_run_id (run_id)',
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [47, 'add_expert_routing_difficulty_columns', expect.any(Number)],
    );
    // v48 drops the removed model proactive monitoring objects.
    expect(query).toHaveBeenCalledWith('DROP TABLE IF EXISTS health_summaries');
    expect(query).toHaveBeenCalledWith('DROP TABLE IF EXISTS health_runs');
    expect(query).toHaveBeenCalledWith('DROP TABLE IF EXISTS health_targets');
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM system_config WHERE `key` IN ('health_monitoring_enabled', 'persistent_monitoring_enabled', 'monitoring_virtual_key_id')",
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [48, 'drop_model_proactive_monitoring', expect.any(Number)],
    );
    // v49：运维监控 Agent 统计按 created_at 窗口聚合 agent_search_runs，补索引。
    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE agent_search_runs ADD INDEX idx_runs_created_at (created_at)',
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [49, 'add_agent_search_runs_created_at_index', expect.any(Number)],
    );
    // v50：系统告警已读状态表。
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS alert_reads'),
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [50, 'add_alert_reads', expect.any(Number)],
    );
    // v51：专家路由配置 v2（无配置行时仅作幂等扫表，不做 env 清理）。
    expect(query).toHaveBeenCalledWith(
      'SELECT id, config FROM expert_routing_configs',
    );
    expect(query).not.toHaveBeenCalledWith(
      'DROP TABLE IF EXISTS intent_classify_logs',
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [51, 'expert_routing_config_v2', expect.any(Number)],
    );
    // v52：escalate_only 绑定档位列。
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE expert_routing_session_bindings ADD COLUMN tier VARCHAR(16) DEFAULT NULL COMMENT '绑定档位(escalate_only 锚点)'",
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [52, 'add_expert_routing_binding_tier', expect.any(Number)],
    );
    // v53：api_requests 路由关联列。
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE api_requests ADD COLUMN route_log_id VARCHAR(255) DEFAULT NULL COMMENT '关联 expert_routing_logs.id'",
    );
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE api_requests ADD COLUMN route_tier VARCHAR(16) DEFAULT NULL COMMENT '命中档位 low/medium/high'",
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [53, 'add_api_requests_route_columns', expect.any(Number)],
    );
    // v54：反馈回放用意图文本列。
    expect(query).toHaveBeenCalledWith(
      "ALTER TABLE expert_routing_logs ADD COLUMN intent_text MEDIUMTEXT NULL COMMENT '清洗后意图文本(截断,反馈回放用)'",
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [54, 'add_expert_routing_log_intent_text', expect.any(Number)],
    );
    expect(conn.commit).toHaveBeenCalledTimes(8);
  });
});

describe('transformExpertRoutingConfigV2', () => {
  test('bands experts, converts session policy, strips removed fields', () => {
    const config = {
      classification_mode: 'expert',
      choice_threshold: 0.6,
      experts: [
        { id: 'a', category: 'review', description: 'd', color: '#fff', type: 'real', provider_id: 'p', model: 'm' },
        { id: 'b', category: 'simple', type: 'real', provider_id: 'p', model: 'm2' },
      ],
      session_binding_policy: { idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
    };
    const { config: upgraded, wasDifficulty } = transformExpertRoutingConfigV2(
      config,
      (expert) => (expert.id === 'a' ? 'high' : undefined),
    );
    expect(wasDifficulty).toBe(false);
    expect(upgraded.version).toBe(2);
    expect(upgraded.experts).toEqual([
      { id: 'a', type: 'real', provider_id: 'p', model: 'm', band: 'high' },
      { id: 'b', type: 'real', provider_id: 'p', model: 'm2', band: 'high' },
    ]);
    expect(upgraded.session_policy).toEqual({
      mode: 'escalate_only',
      idle_ttl_seconds: 60,
      absolute_ttl_seconds: 3600,
    });
    expect(upgraded.session_binding_policy).toBeUndefined();
    expect(upgraded.choice_threshold).toBeUndefined();
    expect(upgraded.classification_mode).toBeUndefined();
  });

  test('difficulty-mode configs keep their identity for binding retention', () => {
    const config = { classification_mode: 'difficulty', experts: [] };
    const { wasDifficulty } = transformExpertRoutingConfigV2(config, () => 'low');
    expect(wasDifficulty).toBe(true);
  });
});

describe('normalizeExpertRoutingConfig', () => {
  test('maps legacy expert categories and removes ignored LLM prompt fields', () => {
    const result = normalizeExpertRoutingConfig(JSON.stringify({
      experts: [
        { id: 'repair', category: 'debug', system_prompt: 'legacy criteria' },
        { id: 'general', category: 'other' },
      ],
      llm_second_pass: {
        type: 'real',
        prompt_template: '{{USER_PROMPT}}',
        system_prompt: 'legacy prompt',
        user_prompt_marker: '{{USER_PROMPT}}',
      },
    }));

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.config)).toEqual({
      experts: [
        { id: 'repair', category: 'code_repair' },
        { id: 'general', category: 'general_inquiry' },
      ],
      llm_second_pass: { type: 'real' },
    });
  });
});
