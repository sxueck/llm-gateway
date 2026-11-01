import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import {
  buildQuotaPeriodSummary,
  buildQuotaSummary,
  getQuotaSummaryHandler,
} from './quota-handlers.js';
import { virtualKeyQuota } from '../../services/virtual-key-quota.js';
import type { VirtualKeyQuotaEntry } from '../../services/virtual-key-quota.js';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getByVirtualKeyId: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  addUsage: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
  getVirtualKeyByKeyValue: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  virtualKeyModelQuotaDb: {
    getAll: mocks.getAll,
    getByVirtualKeyId: mocks.getByVirtualKeyId,
  },
  virtualKeyModelUsageDb: {
    getDayUsage: mocks.getDayUsage,
    getDayTotals: mocks.getDayTotals,
    addUsage: mocks.addUsage,
    renameDayUsage: mocks.renameDayUsage,
    deleteBefore: mocks.deleteBefore,
  },
}));

// 鉴权走真实 auth.ts：这里只替换其依赖的密钥缓存。
vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: {
    getVirtualKeyByKeyValue: mocks.getVirtualKeyByKeyValue,
  },
}));

const KEY = 'sk-quota-summary-test';
const KEY_ID = 'vk-summary';
// 周三上午（上海 +08:00）：文档示例锚点。
const NOW_WED = new Date('2026-03-04T10:30:00+08:00').getTime();

function entry(overrides: Partial<VirtualKeyQuotaEntry> = {}): VirtualKeyQuotaEntry {
  return {
    model: 'gpt-x',
    limitMillions: 1,
    usedTokens: 250_000,
    requestCount: 3,
    weeklyLimitMillions: 5,
    weeklyUsedTokens: 550_000,
    weeklyRequestCount: 6,
    ...overrides,
  };
}

function makeRequestReply(headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) {
  const request: any = { headers };
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
  return { request, reply };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_WED);
  vi.clearAllMocks();
  virtualKeyQuota.resetForTesting();
  mocks.getAll.mockResolvedValue([]);
  mocks.getByVirtualKeyId.mockResolvedValue([
    { virtualKeyId: KEY_ID, model: 'gpt-x', limitMillions: 1, weeklyLimitMillions: 5 },
    { virtualKeyId: KEY_ID, model: 'kimi-k2', limitMillions: 2, weeklyLimitMillions: null },
  ]);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
  mocks.renameDayUsage.mockResolvedValue(undefined);
  mocks.deleteBefore.mockResolvedValue(undefined);
  mocks.getVirtualKeyByKeyValue.mockResolvedValue({
    id: KEY_ID,
    key_value: KEY,
    enabled: 1,
  } as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildQuotaPeriodSummary', () => {
  test('unconfigured ceilings (null / 0 / undefined) surface as null, never a fake 0 cap', () => {
    expect(buildQuotaPeriodSummary(null, 5, 1, 0)).toBeNull();
    expect(buildQuotaPeriodSummary(0, 5, 1, 0)).toBeNull();
    expect(buildQuotaPeriodSummary(undefined, 5, 1, 0)).toBeNull();
  });

  test('converts millions to tokens with the same rounding as the pre-check', () => {
    expect(buildQuotaPeriodSummary(1.5, 0, 0, 0)!.limit_tokens).toBe(1_500_000);
    expect(buildQuotaPeriodSummary(0.001, 0, 0, 0)!.limit_tokens).toBe(1_000);
    expect(buildQuotaPeriodSummary(1.5, 0, 0, 0)!.limit_millions).toBe(1.5);
  });

  test('fail-open overshoot keeps used above the cap but clamps remaining at zero', () => {
    const period = buildQuotaPeriodSummary(1, 1_500_000, 2, 0)!;
    expect(period.used_tokens).toBe(1_500_000);
    expect(period.remaining_tokens).toBe(0);
    expect(period.request_count).toBe(2);
  });
});

describe('buildQuotaSummary reset boundaries', () => {
  test('mid-week Shanghai day: daily resets next local midnight, weekly next Monday', () => {
    const summary = buildQuotaSummary([entry()], NOW_WED, 'Asia/Shanghai');

    expect(summary.timezone).toBe('Asia/Shanghai');
    expect(summary.data[0].daily!.resets_at).toBe('2026-03-04T16:00:00.000Z'); // 周四 00:00 +08
    expect(summary.data[0].weekly!.resets_at).toBe('2026-03-08T16:00:00.000Z'); // 下周一 00:00 +08
  });

  test('Sunday is the last day of the week: weekly resets with the next daily window', () => {
    const now = new Date('2026-03-01T20:00:00+08:00').getTime(); // 周日
    const summary = buildQuotaSummary([entry()], now, 'Asia/Shanghai');

    expect(summary.data[0].daily!.resets_at).toBe('2026-03-01T16:00:00.000Z');
    expect(summary.data[0].weekly!.resets_at).toBe('2026-03-01T16:00:00.000Z');
  });

  test('Monday starts a fresh weekly window resetting seven days out', () => {
    const now = new Date('2026-03-02T09:00:00+08:00').getTime(); // 周一
    const summary = buildQuotaSummary([entry()], now, 'Asia/Shanghai');

    expect(summary.data[0].weekly!.resets_at).toBe('2026-03-08T16:00:00.000Z');
  });

  test('weekly reset instant follows the DST offset of the reset day, not of today', () => {
    // 周三 2026-03-04 仍是 EST(-5)，但重置日下周一落在春令时后的 EDT(-4)。
    const now = new Date('2026-03-04T12:00:00-05:00').getTime();
    const summary = buildQuotaSummary([entry()], now, 'America/New_York');

    expect(summary.data[0].weekly!.resets_at).toBe('2026-03-09T04:00:00.000Z'); // EDT 周一 00:00
  });

  test('daily reset across the fall-back DST day lands on the post-transition offset', () => {
    // 2026-11-01 是纽约秋令时切换日（EDT→EST），次日零点按 EST(-5) 计算。
    const now = new Date('2026-11-01T03:30:00-04:00').getTime();
    const summary = buildQuotaSummary([entry()], now, 'America/New_York');

    expect(summary.data[0].daily!.resets_at).toBe('2026-11-02T05:00:00.000Z');
  });

  test('a dimension without a ceiling is null while the other stays populated', () => {
    const summary = buildQuotaSummary([entry({ weeklyLimitMillions: null })], NOW_WED, 'Asia/Shanghai');

    expect(summary.data[0].daily).not.toBeNull();
    expect(summary.data[0].weekly).toBeNull();
  });
});

describe('GET /v1/quota handler', () => {
  test('missing credentials get the OpenAI 401 envelope', async () => {
    const { request, reply } = makeRequestReply({});

    await getQuotaSummaryHandler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'missing_authorization' }),
    });
  });

  test('a disabled key is rejected with 403 api_key_disabled', async () => {
    mocks.getVirtualKeyByKeyValue.mockResolvedValue({
      id: KEY_ID,
      key_value: KEY,
      enabled: 0,
    } as any);
    const { request, reply } = makeRequestReply();

    await getQuotaSummaryHandler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'api_key_disabled' }),
    });
  });

  test('returns per-model summaries counting in-flight usage, sorted by daily use', async () => {
    // 只给 gpt-x 记 250k（已缓冲未落库）：快照必须把它算进 today 的已用。
    virtualKeyQuota.record(KEY_ID, 'gpt-x', 250_000, NOW_WED);

    const { request, reply } = makeRequestReply();
    await getQuotaSummaryHandler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const payload: any = vi.mocked(reply.send).mock.calls[0][0];
    expect(payload.object).toBe('virtual_key_quota_summary');
    expect(payload.timezone).toBe('Asia/Shanghai');
    expect(payload.data.map((e: any) => e.model)).toEqual(['gpt-x', 'kimi-k2']);

    const [gptX, kimi] = payload.data;
    expect(gptX).toEqual({
      object: 'model_quota',
      model: 'gpt-x',
      daily: {
        limit_millions: 1,
        limit_tokens: 1_000_000,
        used_tokens: 250_000,
        remaining_tokens: 750_000,
        request_count: 1,
        resets_at: '2026-03-04T16:00:00.000Z',
      },
      weekly: {
        limit_millions: 5,
        limit_tokens: 5_000_000,
        used_tokens: 250_000,
        remaining_tokens: 4_750_000,
        request_count: 1,
        resets_at: '2026-03-08T16:00:00.000Z',
      },
    });
    // 未配置周额度：该维度为 null，而不是伪造的 0 上限。
    expect(kimi.weekly).toBeNull();
    expect(kimi.daily).toMatchObject({ limit_millions: 2, limit_tokens: 2_000_000 });
  });

  test('a quota-config read failure surfaces as 500 quota_summary_error', async () => {
    mocks.getByVirtualKeyId.mockRejectedValue(new Error('db down'));

    const { request, reply } = makeRequestReply();
    await getQuotaSummaryHandler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      error: expect.objectContaining({
        type: 'internal_error',
        code: 'quota_summary_error',
      }),
    });
  });

  test('a usage-table read failure fails open like the enforcement pre-check', async () => {
    // 口径与限流一致：用量表读不到不报 500，已用量退回本进程计量。
    mocks.getDayUsage.mockRejectedValue(new Error('usage table down'));
    virtualKeyQuota.record(KEY_ID, 'gpt-x', 250_000, NOW_WED);

    const { request, reply } = makeRequestReply();
    await getQuotaSummaryHandler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    const payload: any = vi.mocked(reply.send).mock.calls[0][0];
    expect(payload.data[0].daily).toMatchObject({ used_tokens: 250_000, request_count: 1 });
  });
});
