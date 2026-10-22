import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCodingAgentRows: vi.fn(),
  getAgentSessionsDetail: vi.fn(),
  getRunTotals: vi.fn(),
  getRunBreakdownByStatus: vi.fn(),
  getRunBreakdownByPlugin: vi.fn(),
  getModelProfiles: vi.fn(),
  getRunErrorCodes: vi.fn(),
  getRunTrend: vi.fn(),
  estimateUsageCost: vi.fn(),
}));

vi.mock('../db/repositories/agent-metrics.repository.js', () => ({
  agentMetricsRepository: {
    getCodingAgentRows: mocks.getCodingAgentRows,
    getAgentSessions: mocks.getAgentSessionsDetail,
    getRunTotals: mocks.getRunTotals,
    getRunBreakdownByStatus: mocks.getRunBreakdownByStatus,
    getRunBreakdownByPlugin: mocks.getRunBreakdownByPlugin,
    getModelProfiles: mocks.getModelProfiles,
    getRunErrorCodes: mocks.getRunErrorCodes,
    getRunTrend: mocks.getRunTrend,
  },
}));
vi.mock('./cost-mapping.js', () => ({
  costMappingService: { estimateUsageCost: mocks.estimateUsageCost },
}));

import {
  getAgentSessions,
  getCodingAgentOverview,
  getWorkerRunOverview,
  isAgentMetricsPeriod,
  resolveAgentWindow,
  type AgentMetricsWindow,
} from './agent-metrics.js';
import type { CodingAgentModelRow } from '../db/repositories/agent-metrics.repository.js';

interface UnitPrice {
  input: number;
  output: number;
  cached: number;
}

/** 与实现的线性口径一致：单价 × 数量求和；表里没有的 model 返回 null。 */
function mockUnitPrices(units: Record<string, UnitPrice>) {
  mocks.estimateUsageCost.mockImplementation(
    async (
      model: string | null | undefined,
      usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
    ) => {
      if (model === null || model === undefined) return null;
      const unit = units[model];
      if (!unit) return null;
      return (
        usage.promptTokens * unit.input +
        usage.completionTokens * unit.output +
        (usage.cachedTokens ?? 0) * unit.cached
      );
    },
  );
}

function agentRow(overrides: Partial<CodingAgentModelRow> = {}): CodingAgentModelRow {
  return {
    userAgent: 'claude-cli/1.0.51 (external, cli)',
    model: 'gpt-4o',
    requests: 1,
    successCount: 1,
    failureCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    lastActiveAt: null,
    ...overrides,
  };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('getCodingAgentOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitPrices({});
  });

  const window: AgentMetricsWindow = {
    period: '24h',
    startTime: 1_700_000_000_000,
    endTime: 1_700_086_400_000,
  };

  it('merges multiple UAs of one agent, buckets unknown UAs, and sorts by requests desc', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({
        userAgent: 'claude-cli/1.0.51 (external, cli)',
        requests: 10,
        successCount: 9,
        failureCount: 1,
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 20,
        totalTokens: 150,
        lastActiveAt: 2_000,
      }),
      agentRow({
        userAgent: 'claude-code/2.0.0',
        requests: 5,
        successCount: 5,
        failureCount: 0,
        promptTokens: 30,
        completionTokens: 20,
        cachedTokens: 0,
        totalTokens: 50,
        lastActiveAt: 3_000,
      }),
      agentRow({
        userAgent: null,
        model: 'gpt-4o',
        requests: 2,
        successCount: 1,
        failureCount: 1,
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 0,
        totalTokens: 15,
        lastActiveAt: 1_000,
      }),
      agentRow({
        userAgent: 'curl/8.6.0',
        requests: 20,
        successCount: 18,
        failureCount: 2,
        promptTokens: 200,
        completionTokens: 80,
        cachedTokens: 0,
        totalTokens: 280,
        lastActiveAt: 4_000,
      }),
    ]);
    const unit = { input: 0.00001, output: 0.00003, cached: 0.000005 };
    mockUnitPrices({ 'gpt-4o': unit });

    const overview = await getCodingAgentOverview(window);

    expect(mocks.getCodingAgentRows).toHaveBeenCalledWith({
      startTime: window.startTime,
      endTime: window.endTime,
    });
    expect(overview.window).toEqual({
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: 'Asia/Shanghai',
    });
    expect(overview.costCoverage).toBe('full');

    // 排序按 requests 降序：curl(20) > claude-code(15) > unknown(2)
    expect(overview.agents.map((a) => a.key)).toEqual(['curl', 'claude-code', 'unknown']);

    const claude = overview.agents[1];
    expect(claude).toMatchObject({
      key: 'claude-code',
      label: 'Claude Code',
      category: 'coding-agent',
      requests: 15,
      successCount: 14,
      failureCount: 1,
      promptTokens: 130,
      completionTokens: 70,
      cachedTokens: 20,
      totalTokens: 200,
      lastActiveAt: 3_000,
      costCoverage: 'full',
    });
    expect(claude.userAgents).toHaveLength(2);
    expect(claude.userAgents).toContain('claude-cli/1.0.51 (external, cli)');
    expect(claude.userAgents).toContain('claude-code/2.0.0');
    // 与 computeCost 相同的运算顺序，精确相等
    expect(claude.estimatedCost).toBe(130 * unit.input + 70 * unit.output + 20 * unit.cached);

    // 空 UA 落到 unknown 且计入 totals.unattributed
    const unknown = overview.agents[2];
    expect(unknown.key).toBe('unknown');
    expect(unknown.userAgents).toEqual([]);
    expect(overview.totals.unattributed).toEqual({
      requests: 2,
      successCount: 1,
      failureCount: 1,
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
    });

    expect(overview.totals).toMatchObject({
      requests: 37,
      successCount: 33,
      failureCount: 4,
      promptTokens: 340,
      completionTokens: 155,
      cachedTokens: 20,
      totalTokens: 495,
      agentCount: 3,
    });
  });

  it('marks an agent partial and nulls its cost when any model is unpriced', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({
        userAgent: 'claude-cli/1.0.51',
        model: 'gpt-4o',
        requests: 3,
        promptTokens: 100,
        completionTokens: 40,
        cachedTokens: 0,
        totalTokens: 140,
      }),
      agentRow({
        userAgent: 'claude-code/2.0.0',
        model: 'mystery-model',
        requests: 2,
        promptTokens: 50,
        completionTokens: 10,
        cachedTokens: 0,
        totalTokens: 60,
      }),
    ]);
    const unit = { input: 0.00001, output: 0.00003, cached: 0.000005 };
    mockUnitPrices({ 'gpt-4o': unit }); // mystery-model 无价

    const overview = await getCodingAgentOverview(window);

    expect(mocks.estimateUsageCost).toHaveBeenCalledWith('mystery-model', {
      promptTokens: 1,
      completionTokens: 0,
      cachedTokens: 0,
    });
    const claude = overview.agents[0];
    expect(claude.key).toBe('claude-code');
    expect(claude.estimatedCost).toBe(null);
    expect(claude.costCoverage).toBe('partial');
    expect(overview.costCoverage).toBe('partial');
    // 任一 agent 成本未知 → 总额置 null，不报偏低值
    expect(overview.totals.estimatedCost).toBe(null);
  });

  it('treats a NULL model as unpriced without probing price for it', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({ userAgent: 'curl/8.6.0', model: null, requests: 1, totalTokens: 5 }),
    ]);
    const overview = await getCodingAgentOverview(window);

    // 空 model 的桶键（""）不参与单价探测：必定无价，探一次只是多一次 DB 读。
    expect(mocks.estimateUsageCost).not.toHaveBeenCalled();
    expect(overview.agents[0].estimatedCost).toBe(null);
    expect(overview.agents[0].costCoverage).toBe('none');
    // 所有 agent 都是 none 时整体口径也是 none，不是 partial。
    expect(overview.costCoverage).toBe('none');
  });
});

describe('getAgentSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnitPrices({});
  });

  const window: AgentMetricsWindow = {
    period: '7d',
    startTime: 1_700_000_000_000,
    endTime: 1_700_604_800_000,
  };
  const t = 1_700_000_000_000;
  const MIN = 60_000;

  it('splits a request series into sessions on gaps over 30 minutes', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({ userAgent: 'claude-cli/1.0.51', model: 'gpt-4o', requests: 1 }),
      agentRow({ userAgent: 'claude-code/2.0.0', model: 'gpt-4o', requests: 1 }),
      agentRow({ userAgent: 'curl/8.6.0', model: 'gpt-4o', requests: 1 }),
    ]);
    // 同一 (ip, virtualKeyId)，间隔 5min / 40min / 5min → 2 个 session
    mocks.getAgentSessionsDetail.mockResolvedValue([
      {
        id: 'r4',
        ip: '1.2.3.4',
        virtualKeyId: 'vk_9',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 60,
        completionTokens: 20,
        cachedTokens: 0,
        cacheHit: 0,
        createdAt: t + 50 * MIN,
        responseTimeMs: 100,
      },
      {
        id: 'r3',
        ip: '1.2.3.4',
        virtualKeyId: 'vk_9',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 70,
        completionTokens: 30,
        cachedTokens: 7,
        cacheHit: 0,
        createdAt: t + 45 * MIN,
        responseTimeMs: 100,
      },
      {
        id: 'r2',
        ip: '1.2.3.4',
        virtualKeyId: 'vk_9',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 50,
        completionTokens: 10,
        cachedTokens: 0,
        cacheHit: 0,
        createdAt: t + 5 * MIN,
        responseTimeMs: 100,
      },
      {
        id: 'r1',
        ip: '1.2.3.4',
        virtualKeyId: 'vk_9',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 100,
        completionTokens: 40,
        cachedTokens: 5,
        cacheHit: 0,
        createdAt: t,
        responseTimeMs: 100,
      },
    ]);
    const unit = { input: 0.00001, output: 0.00003, cached: 0.000005 };
    mockUnitPrices({ 'gpt-4o': unit });

    const result = await getAgentSessions('claude-code', window);

    // 明细查询只带该 key 命中的 UA（curl 不属于 claude-code）
    expect(mocks.getAgentSessionsDetail).toHaveBeenCalledWith(
      { startTime: window.startTime, endTime: window.endTime },
      ['claude-cli/1.0.51', 'claude-code/2.0.0'],
      2000,
    );

    expect(result.key).toBe('claude-code');
    expect(result.window).toEqual({
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: 'Asia/Shanghai',
    });
    // 按 lastAt 降序：后一段 session 在前
    expect(result.sessions).toHaveLength(2);
    const [later, earlier] = result.sessions;

    expect(later).toMatchObject({
      sessionId: 'r3',
      startedAt: t + 45 * MIN,
      lastAt: t + 50 * MIN,
      durationMs: 5 * MIN,
      requests: 2,
      promptTokens: 130,
      completionTokens: 50,
      totalTokens: 180,
      models: ['gpt-4o'],
      ip: '1.2.3.4',
      virtualKeyId: 'vk_9',
    });
    expect(later.estimatedCost).toBe(
      130 * unit.input + 50 * unit.output + 7 * unit.cached,
    );

    expect(earlier).toMatchObject({
      sessionId: 'r1',
      startedAt: t,
      lastAt: t + 5 * MIN,
      durationMs: 5 * MIN,
      requests: 2,
      promptTokens: 150,
      completionTokens: 50,
      totalTokens: 200,
      models: ['gpt-4o'],
      ip: '1.2.3.4',
      virtualKeyId: 'vk_9',
    });
    expect(earlier.estimatedCost).toBe(
      150 * unit.input + 50 * unit.output + 5 * unit.cached,
    );
  });

  it('separates sessions from different (ip, virtualKeyId) groups', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({ userAgent: 'claude-cli/1.0.51', requests: 1 }),
    ]);
    mocks.getAgentSessionsDetail.mockResolvedValue([
      {
        id: 'a2',
        ip: '5.6.7.8',
        virtualKeyId: 'vk_2',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 10,
        completionTokens: 2,
        cachedTokens: 0,
        cacheHit: 0,
        createdAt: t + 2 * MIN,
        responseTimeMs: 10,
      },
      {
        id: 'a1',
        ip: '1.2.3.4',
        virtualKeyId: 'vk_1',
        model: 'gpt-4o',
        status: 'success',
        promptTokens: 20,
        completionTokens: 4,
        cachedTokens: 0,
        cacheHit: 0,
        createdAt: t,
        responseTimeMs: 10,
      },
    ]);
    mockUnitPrices({ 'gpt-4o': { input: 0.001, output: 0.002, cached: 0.001 } });

    const result = await getAgentSessions('claude-code', window);

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['a2', 'a1']);
    expect(result.sessions[0].ip).toBe('5.6.7.8');
    expect(result.sessions[1].ip).toBe('1.2.3.4');
  });

  it('returns no sessions and skips the detail query when the key has no UAs', async () => {
    mocks.getCodingAgentRows.mockResolvedValue([
      agentRow({ userAgent: 'curl/8.6.0', requests: 1 }),
    ]);

    const result = await getAgentSessions('claude-code', window);

    expect(mocks.getAgentSessionsDetail).not.toHaveBeenCalled();
    expect(result.sessions).toEqual([]);
    expect(result.key).toBe('claude-code');
  });
});

describe('getWorkerRunOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates repository results as-is and maps 24h to hour buckets', async () => {
    const start = 472_222 * HOUR_MS; // 对齐 UTC 整点
    const window: AgentMetricsWindow = {
      period: '24h',
      startTime: start,
      endTime: start + 24 * HOUR_MS,
    };
    const totals = {
      runs: 9,
      completed: 7,
      failed: 1,
      cancelled: 0,
      running: 1,
      queued: 0,
      other: 0,
      turns: 20,
      toolCalls: 33,
      inputTokens: 1000,
      outputTokens: 200,
      cost: 1.5,
      avgDurationMs: 12_000,
    };
    const byStatus = [{ status: 'completed', runs: 7, withErrorCode: 0 }];
    const byPlugin = [
      {
        pluginId: 'code-search',
        version: '1.0.0',
        runs: 9,
        completed: 7,
        failed: 1,
        turns: 20,
        toolCalls: 33,
        inputTokens: 1000,
        outputTokens: 200,
        cost: 1.5,
        avgDurationMs: 12_000,
      },
    ];
    const byModelProfile = [{ profile: 'search-fast', runs: 9, cost: 1.5, tokens: 1200 }];
    const errorCodes = [{ errorCode: 'E_TIMEOUT', count: 1 }];
    const trendRows = [
      { bucketStart: start + 2 * HOUR_MS, runs: 5, completed: 4, failed: 1, tokens: 600, cost: 0.8 },
      { bucketStart: start + 10 * HOUR_MS, runs: 4, completed: 3, failed: 0, tokens: 400, cost: 0.7 },
    ];
    mocks.getRunTotals.mockResolvedValue(totals);
    mocks.getRunBreakdownByStatus.mockResolvedValue(byStatus);
    mocks.getRunBreakdownByPlugin.mockResolvedValue(byPlugin);
    mocks.getModelProfiles.mockResolvedValue(byModelProfile);
    mocks.getRunErrorCodes.mockResolvedValue(errorCodes);
    mocks.getRunTrend.mockResolvedValue(trendRows);

    const overview = await getWorkerRunOverview(window);

    expect(overview.granularity).toBe('hour');
    expect(overview.window).toEqual({
      startTime: start,
      endTime: start + 24 * HOUR_MS,
      timezone: 'Asia/Shanghai',
    });
    // 原样聚合（引用透传）
    expect(overview.totals).toBe(totals);
    expect(overview.byStatus).toBe(byStatus);
    expect(overview.byPlugin).toBe(byPlugin);
    expect(overview.byModelProfile).toBe(byModelProfile);
    expect(overview.errorCodes).toBe(errorCodes);

    expect(mocks.getRunTrend).toHaveBeenCalledWith(
      { startTime: start, endTime: start + 24 * HOUR_MS },
      'hour',
    );
    // 补零桶：24 个小时桶，无数据桶为全零
    expect(overview.trend).toHaveLength(24);
    const byBucket = new Map(overview.trend.map((row) => [row.bucketStart, row]));
    expect(byBucket.get(start + 2 * HOUR_MS)).toEqual(trendRows[0]);
    expect(byBucket.get(start + 10 * HOUR_MS)).toEqual(trendRows[1]);
    expect(byBucket.get(start + 3 * HOUR_MS)).toEqual({
      bucketStart: start + 3 * HOUR_MS,
      runs: 0,
      completed: 0,
      failed: 0,
      tokens: 0,
      cost: 0,
    });
  });

  it('maps 7d to day granularity aligned to Shanghai midnight', async () => {
    // 上海 0 点对应的 UTC 时间戳（k*DAY - 8h）
    const start = 19_700 * DAY_MS - 8 * HOUR_MS;
    const window: AgentMetricsWindow = {
      period: '7d',
      startTime: start,
      endTime: start + 7 * DAY_MS,
    };
    mocks.getRunTotals.mockResolvedValue({
      runs: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
      queued: 0,
      other: 0,
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      avgDurationMs: null,
    });
    mocks.getRunBreakdownByStatus.mockResolvedValue([]);
    mocks.getRunBreakdownByPlugin.mockResolvedValue([]);
    mocks.getModelProfiles.mockResolvedValue([]);
    mocks.getRunErrorCodes.mockResolvedValue([]);
    const trendRows = [
      { bucketStart: start + DAY_MS, runs: 2, completed: 2, failed: 0, tokens: 10, cost: 0.1 },
    ];
    mocks.getRunTrend.mockResolvedValue(trendRows);

    const overview = await getWorkerRunOverview(window);

    expect(overview.granularity).toBe('day');
    expect(mocks.getRunTrend).toHaveBeenCalledWith(
      { startTime: start, endTime: start + 7 * DAY_MS },
      'day',
    );
    // 7 个上海日桶（end 恰好是桶边界，不包含）
    expect(overview.trend).toHaveLength(7);
    expect(overview.trend.map((row) => row.bucketStart)).toEqual([
      start,
      start + DAY_MS,
      start + 2 * DAY_MS,
      start + 3 * DAY_MS,
      start + 4 * DAY_MS,
      start + 5 * DAY_MS,
      start + 6 * DAY_MS,
    ]);
    expect(overview.trend[1]).toEqual(trendRows[0]);
    expect(overview.trend[0]).toEqual({
      bucketStart: start,
      runs: 0,
      completed: 0,
      failed: 0,
      tokens: 0,
      cost: 0,
    });
  });
});

describe('resolveAgentWindow / isAgentMetricsPeriod', () => {
  it('computes startTime = endTime - period length for each period', () => {
    const endTime = 1_700_000_000_000;
    expect(resolveAgentWindow('24h', endTime)).toEqual({
      period: '24h',
      startTime: endTime - 24 * HOUR_MS,
      endTime,
    });
    expect(resolveAgentWindow('7d', endTime).startTime).toBe(endTime - 7 * DAY_MS);
    expect(resolveAgentWindow('30d', endTime).startTime).toBe(endTime - 30 * DAY_MS);
  });

  it('defaults endTime to Date.now()', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    try {
      expect(resolveAgentWindow('24h')).toEqual({
        period: '24h',
        startTime: 1_234_567_890 - 24 * HOUR_MS,
        endTime: 1_234_567_890,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('accepts only 24h / 7d / 30d as periods', () => {
    expect(isAgentMetricsPeriod('24h')).toBe(true);
    expect(isAgentMetricsPeriod('7d')).toBe(true);
    expect(isAgentMetricsPeriod('30d')).toBe(true);
    expect(isAgentMetricsPeriod('60m')).toBe(false);
    expect(isAgentMetricsPeriod('')).toBe(false);
    expect(isAgentMetricsPeriod(24)).toBe(false);
  });
});
