import type { Connection } from 'mysql2/promise';
import { describe, expect, test, vi } from 'vitest';
import { applyMigrations, migrations, normalizeExpertRoutingConfig } from './migrations.js';

describe('health runs index migration', () => {
  test('has unique migration versions and applies the index after v45', async () => {
    const versions = migrations.map(migration => migration.version);
    expect(new Set(versions).size).toBe(versions.length);

    const query = vi.fn(async (sql: string) => {
      if (sql.includes('MAX(version)')) return [[{ version: 45 }]];
      if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [[{ cnt: 0 }]];
      return [[]];
    });
    const conn = {
      query,
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
    } as unknown as Connection;

    await applyMigrations(conn);

    expect(query).toHaveBeenCalledWith(
      'ALTER TABLE health_runs ADD INDEX idx_health_runs_target_created_at (target_id, created_at)',
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      [46, 'add_health_runs_target_created_at_index', expect.any(Number)],
    );
    expect(conn.commit).toHaveBeenCalledOnce();
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
