import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    connection,
    getConnection: vi.fn(async () => connection),
  };
});

vi.mock('../connection.js', () => ({
  getDatabase: () => ({ getConnection: mocks.getConnection }),
}));

vi.mock('../../config/index.js', () => ({
  appConfig: { apiRequestLogRetentionDays: 7 },
}));

import { apiRequestRepository } from './api-request.repository.js';

const FIXED_NOW = Date.UTC(2026, 7, 22, 10, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

// 与 getStats 明细/汇总段 SQL 的列别名对齐。
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_requests: 2,
    successful_requests: 2,
    failed_requests: 0,
    total_tokens: 10,
    prompt_tokens: 6,
    completion_tokens: 4,
    cached_tokens: 0,
    total_effective_time: 3000,
    effective_time_count: 2,
    cache_hits: 0,
    prompt_cache_hits: 0,
    ...overrides,
  };
}

describe('apiRequestRepository.getStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('averages effective time over the detail-only window', async () => {
    mocks.connection.query.mockResolvedValue([[row()]]);

    const stats = await apiRequestRepository.getStats();

    expect(stats.avgResponseTime).toBe(1500);
    expect(mocks.connection.query).toHaveBeenCalledTimes(1);
    expect(mocks.connection.release).toHaveBeenCalled();
  });

  it('combines summary and detail segments via effective-time columns', async () => {
    mocks.connection.query
      .mockResolvedValueOnce([
        [row({ total_effective_time: 9000, effective_time_count: 3 })],
      ])
      .mockResolvedValueOnce([
        [row({ total_effective_time: 4000, effective_time_count: 2 })],
      ]);

    const stats = await apiRequestRepository.getStats({
      startTime: FIXED_NOW - 30 * DAY_MS,
      endTime: FIXED_NOW,
    });

    expect(stats.avgResponseTime).toBe(2600);
    expect(mocks.connection.query).toHaveBeenCalledTimes(2);
  });

  it('returns 0 average when no timing data exists', async () => {
    mocks.connection.query.mockResolvedValue([
      [row({ total_effective_time: 0, effective_time_count: 0 })],
    ]);

    const stats = await apiRequestRepository.getStats();

    expect(stats.avgResponseTime).toBe(0);
  });
});