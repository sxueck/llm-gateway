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
    expect(stats.legacyTokenSemantics).toBe(false);
    expect(String(mocks.connection.query.mock.calls[0][0])).not.toContain('schema_migrations');
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

describe('apiRequestRepository.getModelStats unique model option', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('合并供应商重复模型并在 limit null 时返回全部模型', async () => {
    const rows = Array.from({ length: 55 }, (_, index) => ({
      model: `model-${index}`,
      provider_name: 'provider-a',
      request_count: 1,
      total_tokens: index,
      total_response_time: 0,
      response_time_count: 0,
    }));
    rows.push({
      model: 'model-0',
      provider_name: 'provider-b',
      request_count: 2,
      total_tokens: 100,
      total_response_time: 0,
      response_time_count: 0,
    });
    mocks.connection.query.mockResolvedValueOnce([rows]);

    const stats = await apiRequestRepository.getModelStats({
      startTime: FIXED_NOW,
      endTime: FIXED_NOW + 1,
      sortBy: 'tokens',
      uniqueModels: true,
      limit: null,
    });

    expect(stats).toHaveLength(55);
    expect(stats.find((stat) => stat.model === 'model-0')?.total_tokens).toBe(100);
    expect(mocks.connection.release).toHaveBeenCalled();
  });
});

describe('apiRequestRepository 请求来源读取遵守页面筛选器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
    mocks.connection.query.mockResolvedValue([[]]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function issuedQueries(): Array<{ sql: string; params: unknown[] }> {
    return mocks.connection.query.mock.calls.map((call) => ({
      sql: String(call[0]),
      params: call[1] as unknown[],
    }));
  }

  const filters = {
    virtualKeyId: 'vk-1',
    model: 'gpt-4o',
    providerId: 'p-1',
  };

  it('getLastRequest 把筛选器写进 SQL 与参数', async () => {
    await apiRequestRepository.getLastRequest(FIXED_NOW, FIXED_NOW + 1, filters);
    const [query] = issuedQueries();
    expect(query.sql).toContain('ar.virtual_key_id = ?');
    expect(query.sql).toContain('ar.model = ?');
    expect(query.sql).toContain('ar.provider_id = ?');
    expect(query.params).toEqual([FIXED_NOW, FIXED_NOW + 1, 'vk-1', 'gpt-4o', 'p-1']);
  });

  it('getRecentUniqueIps 的参数顺序是窗口、筛选器、limit', async () => {
    await apiRequestRepository.getRecentUniqueIps(50, FIXED_NOW, FIXED_NOW + 1, filters);
    const [query] = issuedQueries();
    expect(query.sql).toContain('ar.model = ?');
    expect(query.sql).toContain('disable_logging');
    expect(query.params).toEqual([
      FIXED_NOW,
      FIXED_NOW + 1,
      'vk-1',
      'gpt-4o',
      'p-1',
      50,
    ]);
  });

  it('getLastRequestByIp 保留 ip 首参并追加筛选器', async () => {
    await apiRequestRepository.getLastRequestByIp(
      '1.2.3.4',
      FIXED_NOW,
      FIXED_NOW + 1,
      { virtualKeyId: 'vk-1' },
    );
    const [query] = issuedQueries();
    expect(query.params).toEqual(['1.2.3.4', FIXED_NOW, FIXED_NOW + 1, 'vk-1']);
  });

  it('不传筛选器时口径不变（GET /stats 历史行为）', async () => {
    await apiRequestRepository.getLastRequest(FIXED_NOW, FIXED_NOW + 1);
    await apiRequestRepository.getRecentUniqueIps(50, FIXED_NOW, FIXED_NOW + 1);
    expect(issuedQueries().every((q) => !q.sql.includes('ar.model = ?'))).toBe(true);
    expect(issuedQueries()[1].params).toEqual([FIXED_NOW, FIXED_NOW + 1, 50]);
  });

  it('getAll 把会话/IP/协议/缓存命中筛选写进 SQL 与参数', async () => {
    mocks.connection.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);

    await apiRequestRepository.getAll({
      limit: 20,
      offset: 0,
      virtualKeyId: 'vk-1',
      sessionId: 's-1',
      ip: '1.2.3.4',
      requestType: 'anthropic',
      cacheHit: false,
    });

    const dataQuery = issuedQueries()[1];
    for (const fragment of [
      'ar.virtual_key_id = ?',
      'ar.session_id = ?',
      'ar.ip = ?',
      'ar.request_type = ?',
      'ar.cache_hit = ?',
    ]) {
      expect(dataQuery.sql).toContain(fragment);
    }
    // 参数顺序必须与 WHERE 拼接顺序一致，否则错位筛选。
    expect(dataQuery.params).toEqual(['vk-1', 's-1', '1.2.3.4', 'anthropic', 0, 20, 0]);
  });
});

describe('apiRequestRepository.getSession', () => {
  const GAP = 30 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function anchor(overrides: Record<string, unknown> = {}) {
    return {
      id: 'r-2',
      session_id: null,
      virtual_key_id: 'vk-1',
      ip: '1.2.3.4',
      created_at: FIXED_NOW,
      ...overrides,
    };
  }

  it('有显式 session_id 时按 session 精确取升序序列', async () => {
    mocks.connection.query
      .mockResolvedValueOnce([[anchor({ session_id: 's-1' })]])
      .mockResolvedValueOnce([
        [
          { id: 'r-1', created_at: FIXED_NOW - 1000 },
          { id: 'r-2', created_at: FIXED_NOW },
        ],
      ]);

    const session = await apiRequestRepository.getSession('r-2');
    expect(session?.strategy).toBe('explicit');
    expect(session?.sessionId).toBe('s-1');
    expect(session?.requests.map((row) => row.id)).toEqual(['r-1', 'r-2']);
    expect(session?.anchorIndex).toBe(1);
    expect(session?.truncated).toBe(false);
    const dataSql = String(mocks.connection.query.mock.calls[1][0]);
    expect(dataSql).toContain('session_id = ?');
    // 同一标识可能被别的密钥撞用：限定同密钥并套用 disable_logging 口径。
    expect(dataSql).toContain('ar.virtual_key_id <=> ?');
    expect(dataSql).toContain('disable_logging');
    expect(mocks.connection.query.mock.calls[1][1]).toEqual(['s-1', 'vk-1', 501]);
  });

  it('无 session_id 时按 (虚拟密钥, IP) + gap 切段，只保留锚点所属段', async () => {
    const rows = [
      { id: 'a-1', created_at: FIXED_NOW },
      { id: 'a-2', created_at: FIXED_NOW + 60_000 },
      { id: 'b-1', created_at: FIXED_NOW + 60_000 + GAP + 1 },
      { id: 'b-2', created_at: FIXED_NOW + 60_000 + GAP + 2_000 },
      { id: 'c-1', created_at: FIXED_NOW + 60_000 + GAP + 2_000 + GAP + 1 },
    ];
    mocks.connection.query
      .mockResolvedValueOnce([[anchor({ id: 'b-2' })]])
      .mockResolvedValueOnce([rows]);

    const session = await apiRequestRepository.getSession('b-2');
    expect(session?.strategy).toBe('heuristic');
    expect(session?.sessionId).toBeNull();
    expect(session?.requests.map((row) => row.id)).toEqual(['b-1', 'b-2']);
    expect(session?.anchorIndex).toBe(1);
    expect(session?.truncated).toBe(false);
    // 空值安全等号：ip 为 NULL 的旧行也要能同组。
    expect(String(mocks.connection.query.mock.calls[1][0])).toContain('<=>');
  });

  it('扫描截断（锚点不在扫描结果里）时返回空序列并如实标记', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      id: `old-${index}`,
      created_at: FIXED_NOW - 1000 + index,
    }));
    mocks.connection.query
      .mockResolvedValueOnce([[anchor()]])
      .mockResolvedValueOnce([rows]);

    const session = await apiRequestRepository.getSession('r-2');
    expect(session?.strategy).toBe('heuristic');
    expect(session?.requests).toEqual([]);
    expect(session?.anchorIndex).toBe(-1);
    expect(session?.truncated).toBe(true);
  });

  it('会话起点顶到回溯窗口边界时标记 truncated', async () => {
    const rows = Array.from({ length: 145 }, (_, index) => ({
      id: `s-${index}`,
      created_at: FIXED_NOW - 144 * 10 * 60 * 1000 + index * 10 * 60 * 1000,
    }));
    rows[rows.length - 1].id = 'r-2';
    mocks.connection.query
      .mockResolvedValueOnce([[anchor()]])
      .mockResolvedValueOnce([rows]);

    const session = await apiRequestRepository.getSession('r-2');
    expect(session?.truncated).toBe(true);
    expect(session?.anchorIndex).toBe(144);
  });

  it('锚点不在表里时返回 undefined', async () => {
    mocks.connection.query.mockResolvedValueOnce([[]]);
    expect(await apiRequestRepository.getSession('missing')).toBeUndefined();
  });
});
