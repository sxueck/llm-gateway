import type { Connection } from 'mysql2/promise';
import { describe, expect, test, vi } from 'vitest';
import { applyMigrations, migrations, normalizeExpertRoutingConfig } from './migrations.js';

describe('migration runner from v45', () => {
  test('has unique migration versions and applies v47/v48 after v45', async () => {
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
    expect(conn.commit).toHaveBeenCalledTimes(2);
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
