import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEnabled: vi.fn(),
  getByTargetsTimeWindow: vi.fn(),
  getStatsByTargets: vi.fn(),
  getRecentByTargets: vi.fn(),
  getByTimeWindow: vi.fn(),
  getStats: vi.fn(),
  getByTargetId: vi.fn(),
  getTargetPage: vi.fn(),
  countByTarget: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  healthTargetDb: { getEnabled: mocks.getEnabled },
  healthRunDb: mocks,
}));

import { healthAggregatorService } from './health-aggregator.js';

describe('health aggregator bulk queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthAggregatorService.clearCache();
  });

  it('builds target summaries from three batched queries without per-target reads', async () => {
    const now = Date.now();
    const targets = [
      { id: 'a', name: 'A', type: 'model', check_interval_seconds: 300 },
      { id: 'b', name: 'B', type: 'virtual_model', check_interval_seconds: 300 },
    ];
    const runs = [
      { id: 'r1', target_id: 'a', status: 'success', created_at: now - 2000, latency_ms: 20, error_message: null },
      { id: 'r2', target_id: 'a', status: 'error', created_at: now - 1000, latency_ms: 30, error_message: 'timeout' },
    ];
    mocks.getEnabled.mockResolvedValue(targets);
    mocks.getByTargetsTimeWindow.mockResolvedValue(new Map([['a', runs]]));
    mocks.getStatsByTargets.mockResolvedValue(new Map([['a', {
      totalChecks: 2, successCount: 1, errorCount: 1, avgLatency: 25,
    }]]));
    mocks.getRecentByTargets.mockResolvedValue(new Map([['a', [...runs].reverse()]]));

    const summaries = await healthAggregatorService.getAllTargetsSummary();

    expect(summaries.map(summary => summary.targetId)).toEqual(['a', 'b']);
    expect(summaries[0].stats24h.totalChecks).toBe(2);
    expect(summaries[0].stats7d.availability).toBe(50);
    expect(summaries[0].latestCheck?.errorMessage).toBe('timeout');
    expect(summaries[0].healthHistory?.map(run => run.status)).toEqual(['error', 'success']);
    expect(summaries[1].stats7d.totalChecks).toBe(0);
    expect(summaries[1].currentStatus).toBe('unknown');
    expect(mocks.getByTargetsTimeWindow).toHaveBeenCalledOnce();
    expect(mocks.getStatsByTargets).toHaveBeenCalledOnce();
    expect(mocks.getRecentByTargets).toHaveBeenCalledWith(['a', 'b'], 100);
    expect(mocks.getByTimeWindow).not.toHaveBeenCalled();
    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.getByTargetId).not.toHaveBeenCalled();
  });

  it('shares a cache-miss load across concurrent summary requests', async () => {
    mocks.getEnabled.mockResolvedValue([
      { id: 'a', name: 'A', type: 'model', check_interval_seconds: 300 },
    ]);
    let resolveRuns!: (runs: Map<string, unknown[]>) => void;
    mocks.getByTargetsTimeWindow.mockImplementation(() => new Promise(resolve => {
      resolveRuns = resolve;
    }));
    mocks.getStatsByTargets.mockResolvedValue(new Map());
    mocks.getRecentByTargets.mockResolvedValue(new Map());

    const first = healthAggregatorService.getAllTargetsSummary();
    const second = healthAggregatorService.getAllTargetsSummary();
    await vi.waitFor(() => expect(mocks.getByTargetsTimeWindow).toHaveBeenCalledOnce());
    resolveRuns(new Map());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(mocks.getEnabled).toHaveBeenCalledOnce();
  });

  it('uses one time window for page rows and the matching count', async () => {
    mocks.getTargetPage.mockResolvedValue([{ id: 'run' }]);
    mocks.countByTarget.mockResolvedValue(123);

    const before = Date.now();
    const page = await healthAggregatorService.getTargetRunsPage('a', {
      window: '7d', limit: 50, offset: 100,
    });
    const after = Date.now();

    expect(page).toEqual({ runs: [{ id: 'run' }], total: 123 });
    const [id, start, end, limit, offset] = mocks.getTargetPage.mock.calls[0];
    expect(id).toBe('a');
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
    expect(start).toBe(end - 7 * 24 * 60 * 60 * 1000);
    expect([limit, offset]).toEqual([50, 100]);
    expect(mocks.countByTarget).toHaveBeenCalledWith(id, start, end);
  });
});
