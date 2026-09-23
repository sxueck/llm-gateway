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
        [row({ total_effective_time: 9000, effective_time_count: 3, legacy_token_semantics: 1 })],
      ])
      .mockResolvedValueOnce([
        [row({ total_effective_time: 4000, effective_time_count: 2 })],
      ]);

    const stats = await apiRequestRepository.getStats({
      startTime: FIXED_NOW - 30 * DAY_MS,
      endTime: FIXED_NOW,
    });

    expect(stats.avgResponseTime).toBe(2600);
    expect(stats.legacyTokenSemantics).toBe(true);
    expect(String(mocks.connection.query.mock.calls[0][0])).toContain('s.cache_hit_count > 0');
    expect(mocks.connection.query).toHaveBeenCalledTimes(2);
  });

  it('does not flag a period without legacy cache-hit summaries', async () => {
    mocks.connection.query.mockResolvedValue([[row()]]);
    const stats = await apiRequestRepository.getStats();
    expect(stats.legacyTokenSemantics).toBe(false);
  });

  it('returns 0 average when no timing data exists', async () => {
    mocks.connection.query.mockResolvedValue([
      [row({ total_effective_time: 0, effective_time_count: 0 })],
    ]);

    const stats = await apiRequestRepository.getStats();

    expect(stats.avgResponseTime).toBe(0);
  });
});
describe('apiRequestRepository 首页统计口径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
    mocks.connection.query.mockResolvedValue([[row()]]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function issuedSql(): string[] {
    return mocks.connection.query.mock.calls.map((call) => String(call[0]));
  }

  it('getStats 聚合（明细段与汇总段）纳入 disable_logging 密钥', async () => {
    await apiRequestRepository.getStats({
      startTime: FIXED_NOW - 30 * DAY_MS,
      endTime: FIXED_NOW,
    });

    const sql = issuedSql();
    expect(sql.length).toBe(2);
    expect(sql.every((q) => !q.includes('disable_logging'))).toBe(true);
  });

  it('getTrend 按天（汇总+明细双读）聚合纳入 disable_logging 密钥', async () => {
    const trend = await apiRequestRepository.getTrend({
      startTime: FIXED_NOW - 30 * DAY_MS,
      endTime: FIXED_NOW,
      interval: 'day',
    });

    expect(trend.length).toBeGreaterThan(0);
    const sql = issuedSql();
    expect(sql.length).toBe(2);
    expect(sql.every((q) => !q.includes('disable_logging'))).toBe(true);
    expect(sql[1]).toContain('CASE WHEN ar.cache_hit = 0 THEN ar.total_tokens ELSE 0 END');
  });

  it('日志列表 endTime 使用与运维聚合一致的半开区间', async () => {
    await apiRequestRepository.getAll({ endTime: FIXED_NOW, limit: 1 });
    const sql = issuedSql();
    expect(sql).toHaveLength(2);
    expect(sql.every((q) => q.includes('ar.created_at < ?'))).toBe(true);
    expect(sql.every((q) => !q.includes('ar.created_at <= ?'))).toBe(true);
  });

  it('隐私限制保留：getAll/getById 仍排除 disable_logging 密钥记录', async () => {
    await apiRequestRepository.getAll({ limit: 1 });
    await apiRequestRepository.getById('req-1');
    await apiRequestRepository.getRecentUniqueIps(5);

    const sql = issuedSql();
    // getAll 发 count + data 两条；getById、getRecentUniqueIps 各一条。
    expect(sql.length).toBe(4);
    expect(sql.every((q) => q.includes('disable_logging'))).toBe(true);
  });
});
