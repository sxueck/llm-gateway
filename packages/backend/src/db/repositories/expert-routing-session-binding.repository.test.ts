import { beforeEach, describe, expect, test, vi } from 'vitest';

// Shared mutable mock connection. The repository under test imports
// `getDatabase` from '../connection.js'; we replace the pool's
// `getConnection()` with whatever connection each test installs.
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
  expertRoutingSessionBindingRepository,
  resolveBindingScope,
  type SessionBindingKey,
} from './expert-routing-session-binding.repository.js';
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
  return {
    query,
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(() => {}),
  };
}

const KEY: SessionBindingKey = {
  expertRoutingId: 'routing-a',
  virtualKeyScope: 'vk-a',
  sessionId: 'session-1',
};

describe('resolveBindingScope', () => {
  test('uses the virtual key id when present', () => {
    expect(resolveBindingScope('vk-1')).toBe('vk-1');
  });

  test('falls back to the non-null anonymous sentinel for null/blank/whitespace ids', () => {
    expect(resolveBindingScope(undefined)).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
    expect(resolveBindingScope('')).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
    expect(resolveBindingScope('   ')).toBe(EXPERT_ROUTING_ANONYMOUS_SCOPE);
  });
});

describe('expertRoutingSessionBindingRepository.getActiveBinding', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('renews and returns the row when the UPDATE matches an active binding', async () => {
    const conn = makeMockConnection({
      updateAffected: 1,
      selectRows: [{ expert_id: 'expert-1', route_source: 'local_onnx' }],
    });
    connectionMock.setConnection(conn);

    const row = await expertRoutingSessionBindingRepository.getActiveBinding(KEY, 60, 1000);

    expect(row).not.toBeNull();
    expect(row?.expert_id).toBe('expert-1');
    // First statement is the atomic renewal UPDATE.
    const firstSql = String(conn.query.mock.calls[0][0]);
    expect(firstSql).toContain('UPDATE expert_routing_session_bindings');
    expect(firstSql).toMatch(/idle_expires_at\s*=\s*LEAST/);
    expect(firstSql).toMatch(/absolute_expires_at\s*>\s*\?/);
    expect(conn.release).toHaveBeenCalled();
  });

  test('returns null and deletes the expired row when no active binding matches', async () => {
    const conn = makeMockConnection({ updateAffected: 0, deleteAffected: 1 });
    connectionMock.setConnection(conn);

    const row = await expertRoutingSessionBindingRepository.getActiveBinding(KEY, 60, 1000);

    expect(row).toBeNull();
    const deleteSql = String(conn.query.mock.calls[1][0]);
    expect(deleteSql).toContain('DELETE FROM expert_routing_session_bindings');
    expect(deleteSql).toMatch(/absolute_expires_at\s*<=\s*\?|idle_expires_at\s*<=\s*\?/);
  });
});

describe('expertRoutingSessionBindingRepository.createOrSelectBinding', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('a fresh insert (affectedRows === 1) is the race winner and commits', async () => {
    const conn = makeMockConnection({
      insertAffected: 1,
      selectRows: [{ expert_id: 'expert-1', route_source: 'local_onnx' }],
    });
    connectionMock.setConnection(conn);

    const result = await expertRoutingSessionBindingRepository.createOrSelectBinding(
      KEY,
      { expertId: 'expert-1', routeSource: 'local_onnx' },
      60,
      3600,
      1000
    );

    expect(result.winner).toBe(true);
    expect(result.row.expert_id).toBe('expert-1');
    expect(conn.beginTransaction).toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.rollback).not.toHaveBeenCalled();
    // INSERT uses ON DUPLICATE KEY UPDATE; SELECT locks with FOR UPDATE.
    const insertSql = String(conn.query.mock.calls[0][0]);
    const selectSql = String(conn.query.mock.calls[1][0]);
    expect(insertSql).toContain('ON DUPLICATE KEY UPDATE');
    expect(selectSql).toContain('FOR UPDATE');
  });

  test('an existing row (affectedRows === 0) is the race loser', async () => {
    const conn = makeMockConnection({
      insertAffected: 0,
      selectRows: [{ expert_id: 'expert-other', route_source: 'session' }],
    });
    connectionMock.setConnection(conn);

    const result = await expertRoutingSessionBindingRepository.createOrSelectBinding(
      KEY,
      { expertId: 'expert-1', routeSource: 'local_onnx' },
      60,
      3600,
      1000
    );

    expect(result.winner).toBe(false);
    expect(result.row.expert_id).toBe('expert-other');
  });

  test('rolls back and rethrows when the locking SELECT fails', async () => {
    const conn = makeMockConnection({ insertAffected: 1 });
    // INSERT succeeds, then the SELECT ... FOR UPDATE fails.
    conn.query
      .mockImplementationOnce(async () => [{ affectedRows: 1 }])
      .mockRejectedValueOnce(new Error('boom'));
    connectionMock.setConnection(conn);

    await expect(
      expertRoutingSessionBindingRepository.createOrSelectBinding(
        KEY,
        { expertId: 'expert-1', routeSource: 'local_onnx' },
        60,
        3600,
        1000
      )
    ).rejects.toThrow('boom');
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

describe('expertRoutingSessionBindingRepository.deleteByExpert / deleteByConfig', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('deleteByExpert returns affectedRows and scopes by expert id', async () => {
    const conn = makeMockConnection({ deleteAffected: 3 });
    connectionMock.setConnection(conn);

    const n = await expertRoutingSessionBindingRepository.deleteByExpert('routing-a', 'expert-1');

    expect(n).toBe(3);
    const sql = String(conn.query.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM expert_routing_session_bindings');
    expect(sql).toMatch(/expert_id\s*=\s*\?/);
  });

  test('deleteByConfig clears every binding for the config', async () => {
    const conn = makeMockConnection({ deleteAffected: 5 });
    connectionMock.setConnection(conn);

    const n = await expertRoutingSessionBindingRepository.deleteByConfig('routing-a');

    expect(n).toBe(5);
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM expert_routing_session_bindings');
    expect(params).toContain('routing-a');
  });
});

describe('expertRoutingSessionBindingRepository.cleanupExpired', () => {
  beforeEach(() => {
    connectionMock.setConnection(null);
  });

  test('issues a bounded DELETE with LIMIT', async () => {
    const conn = makeMockConnection({ deleteAffected: 42 });
    connectionMock.setConnection(conn);

    const n = await expertRoutingSessionBindingRepository.cleanupExpired(1000, 500);

    expect(n).toBe(42);
    const [sql, params] = conn.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM expert_routing_session_bindings');
    expect(sql).toMatch(/LIMIT \?/);
    expect(params).toContain(500);
  });
});
