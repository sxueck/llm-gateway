import { beforeEach, describe, expect, test, vi } from 'vitest';

const connectionMock = vi.hoisted(() => {
  let current: any = null;
  return {
    getDatabase: () => ({ getConnection: async () => current }),
    setConnection: (c: any) => {
      current = c;
    },
  };
});

vi.mock('../connection.js', () => ({ getDatabase: connectionMock.getDatabase }));

import {
  contextNormalizationRepository,
  resolveContextBindingScope,
  type ContextBindingKey,
} from './context-normalization.repository.js';
import { EXPERT_ROUTING_ANONYMOUS_SCOPE } from '@llm-gateway/shared';

interface MockConnOpts {
  updateAffected?: number;
  insertAffected?: number;
  deleteAffected?: number;
  selectRows?: any[];
}

function makeMockConnection(opts: MockConnOpts = {}) {
  const query = vi.fn(async (sql: string, _params?: any) => {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('UPDATE')) return [{ affectedRows: opts.updateAffected ?? 0 }];
    if (s.startsWith('INSERT')) return [{ affectedRows: opts.insertAffected ?? 1 }];
    if (s.startsWith('DELETE')) return [{ affectedRows: opts.deleteAffected ?? 0 }];
    if (s.startsWith('SELECT')) return [opts.selectRows ?? []];
    return [[]];
  });
  return { query, release: vi.fn(() => {}) };
}

const KEY: ContextBindingKey = {
  virtualKeyScope: 'vk-a',
  sessionId: 'session-1',
};

describe('resolveContextBindingScope', () => {
  test('uses the virtual key id when present', () => {
    expect(resolveContextBindingScope('vk-1')).toBe('vk-1');
  });

  test('falls back to the anonymous sentinel for null/blank ids', () => {
    expect(resolveContextBindingScope(undefined)).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
    expect(resolveContextBindingScope('')).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
    expect(resolveContextBindingScope('   ')).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
  });
});

describe('contextNormalizationRepository.getActiveBinding', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('renews and returns the row when the UPDATE matches an active binding', async () => {
    const conn = makeMockConnection({
      updateAffected: 1,
      selectRows: [{ fingerprint: 'fp-1', context_version: 1, protocol: 'openai' }],
    });
    connectionMock.setConnection(conn);

    const row = await contextNormalizationRepository.getActiveBinding(KEY, 60, 1000);

    expect(row).not.toBeNull();
    expect(row?.fingerprint).toBe('fp-1');
    const firstSql = String(conn.query.mock.calls[0][0]);
    expect(firstSql).toContain('UPDATE session_context_bindings');
    expect(firstSql).toMatch(/absolute_expires_at\s*>\s*\?/);
    expect(conn.release).toHaveBeenCalled();
  });

  test('returns null and deletes the expired row when no active binding matches', async () => {
    const conn = makeMockConnection({ updateAffected: 0, deleteAffected: 1 });
    connectionMock.setConnection(conn);

    const row = await contextNormalizationRepository.getActiveBinding(KEY, 60, 1000);

    expect(row).toBeNull();
    const deleteSql = String(conn.query.mock.calls[1][0]);
    expect(deleteSql).toContain('DELETE FROM session_context_bindings');
  });
});

describe('contextNormalizationRepository.createBinding', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('inserts and returns the persisted row', async () => {
    const conn = makeMockConnection({
      insertAffected: 1,
      selectRows: [{ fingerprint: 'fp-new', context_version: 1 }],
    });
    connectionMock.setConnection(conn);

    const row = await contextNormalizationRepository.createBinding(KEY, 'fp-new', 'openai', 60, 3600, 1000);

    expect(row.fingerprint).toBe('fp-new');
    const insertSql = String(conn.query.mock.calls[0][0]);
    expect(insertSql).toContain('INSERT INTO session_context_bindings');
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE');
  });
});

describe('contextNormalizationRepository.updateBindingOnSwitch', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('updates fingerprint, bumps version, refreshes expiry', async () => {
    const conn = makeMockConnection({
      selectRows: [{ fingerprint: 'fp-2', context_version: 2 }],
    });
    connectionMock.setConnection(conn);

    const row = await contextNormalizationRepository.updateBindingOnSwitch(KEY, 'fp-2', 'anthropic', 60, 1000);

    expect(row?.fingerprint).toBe('fp-2');
    expect(row?.context_version).toBe(2);
    const updateSql = String(conn.query.mock.calls[0][0]);
    expect(updateSql).toContain('UPDATE session_context_bindings');
    expect(updateSql).toMatch(/context_version\s*=\s*context_version\s*\+\s*1/);
    expect(updateSql).toMatch(/idle_expires_at\s*=\s*LEAST/);
    expect(updateSql).not.toMatch(/absolute_expires_at\s*=/);
  });
});

describe('contextNormalizationRepository.insertSwitchEvent', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('inserts an audit event row', async () => {
    const conn = makeMockConnection({ insertAffected: 1 });
    connectionMock.setConnection(conn);

    await contextNormalizationRepository.insertSwitchEvent({
      virtualKeyId: 'vk-1',
      sessionId: 'session-1',
      protocol: 'openai',
      sourceFingerprint: 'fp-old',
      targetFingerprint: 'fp-new',
      sourceContextVersion: 1,
      targetContextVersion: 2,
      strategy: 'cleaned',
      cleanedBlocks: 3,
      cleanedChars: 120,
    });

    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO context_switch_events');
    expect(params).toContain('fp-new');
    expect(params).toContain('cleaned');
  });
});

describe('contextNormalizationRepository.cleanupExpiredBindings', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('issues a bounded DELETE with LIMIT', async () => {
    const conn = makeMockConnection({ deleteAffected: 7 });
    connectionMock.setConnection(conn);

    const n = await contextNormalizationRepository.cleanupExpiredBindings(1000, 500);

    expect(n).toBe(7);
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM session_context_bindings');
    expect(sql).toMatch(/LIMIT \?/);
    expect(params).toContain(500);
  });
});

describe('contextNormalizationRepository.deleteBindingsByScope', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('deletes bindings for the virtual-key scope', async () => {
    const conn = makeMockConnection({ deleteAffected: 3 });
    connectionMock.setConnection(conn);

    const n = await contextNormalizationRepository.deleteBindingsByScope('vk-a');

    expect(n).toBe(3);
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM session_context_bindings');
    expect(sql).toContain('virtual_key_scope');
    expect(params).toContain('vk-a');
  });
});

describe('contextNormalizationRepository.cleanupOldSwitchEvents', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('issues a bounded DELETE by created_at', async () => {
    const conn = makeMockConnection({ deleteAffected: 4 });
    connectionMock.setConnection(conn);

    const n = await contextNormalizationRepository.cleanupOldSwitchEvents(10_000, 1000, 200);

    expect(n).toBe(4);
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM context_switch_events');
    expect(sql).toMatch(/created_at\s*<=\s*\?/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(params).toEqual([9000, 200]);
  });
});
