import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../connection.js', () => ({
  getDatabase: () => ({ getConnection: async () => mocks }),
}));

import { healthRunRepository } from './health-run.repository.js';

describe('health run repository batched reads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters and pages a target with bounded parameters', async () => {
    const rows = [{ id: 'r1', target_id: 'a' }];
    mocks.query.mockResolvedValueOnce([rows]).mockResolvedValueOnce([[{ total: '123' }]]);

    expect(await healthRunRepository.getTargetPage('a', 100, 200, 25, 50)).toEqual(rows);
    expect(await healthRunRepository.countByTarget('a', 100, 200)).toBe(123);

    expect(mocks.query.mock.calls[0][0]).toContain('LIMIT ? OFFSET ?');
    expect(mocks.query.mock.calls[0][1]).toEqual(['a', 100, 200, 25, 50]);
    expect(mocks.query.mock.calls[1][1]).toEqual(['a', 100, 200]);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('keeps each target\'s recent runs separate', async () => {
    const a = { id: 'r1', target_id: 'a', created_at: 150 };
    const b = { id: 'r2', target_id: 'b', created_at: 140 };
    mocks.query.mockResolvedValueOnce([[a, b]]);

    const recent = await healthRunRepository.getRecentByTargets(['a', 'b'], 100);

    expect(recent.get('a')).toEqual([a]);
    expect(recent.get('b')).toEqual([b]);
    expect(mocks.query.mock.calls[0][0]).toContain('PARTITION BY target_id ORDER BY created_at DESC');
    expect(mocks.query.mock.calls[0][1]).toEqual(['a', 'b', 100]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('groups only the requested target runs and normalizes aggregate values', async () => {
    const a = { id: 'r1', target_id: 'a', status: 'success', created_at: 100 };
    const b = { id: 'r2', target_id: 'b', status: 'error', created_at: 120 };
    mocks.query.mockResolvedValueOnce([[a, b]]).mockResolvedValueOnce([[
      { target_id: 'a', total_checks: '2', success_count: '1', error_count: '1', avg_latency: '25.5', min_latency: 20, max_latency: 31 },
    ]]);

    const runs = await healthRunRepository.getByTargetsTimeWindow(['a', 'b'], 0, 200);
    const stats = await healthRunRepository.getStatsByTargets(['a', 'b'], 0, 200);

    expect(runs.get('a')).toEqual([a]);
    expect(runs.get('b')).toEqual([b]);
    expect(stats.get('a')).toMatchObject({ totalChecks: 2, successCount: 1, errorCount: 1, avgLatency: 26 });
    expect(stats.has('b')).toBe(false);
    expect(mocks.query.mock.calls[0][1]).toEqual(['a', 'b', 0, 200]);
    expect(mocks.query.mock.calls[1][1]).toEqual(['a', 'b', 0, 200]);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});
