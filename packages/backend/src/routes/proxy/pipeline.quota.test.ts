import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import {
  currentQuotaModel,
  runWithQuotaContext,
  virtualKeyQuota,
} from '../../services/virtual-key-quota.js';
import { formatRetryDuration, runProxyPipeline } from './pipeline.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getByVirtualKeyId: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  virtualKeyModelQuotaDb: {
    getAll: mocks.getAll,
    getByVirtualKeyId: mocks.getByVirtualKeyId,
  },
  virtualKeyModelUsageDb: {
    addUsage: mocks.addUsage,
    getDayUsage: mocks.getDayUsage,
    getDayTotals: mocks.getDayTotals,
    renameDayUsage: mocks.renameDayUsage,
    deleteBefore: mocks.deleteBefore,
  },
}));

vi.mock('../../services/anti-bot.js', () => ({
  antiBotService: {
    detect: vi.fn(() => ({ shouldBlock: false })),
    logDetection: vi.fn(),
  },
}));

vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: {
    getVirtualKeyByKeyValue: vi.fn(),
  },
}));

vi.mock('./model-resolver.js', () => ({
  resolveModelAndProvider: vi.fn(),
}));

vi.mock('./provider-config-builder.js', () => ({
  buildProviderConfig: vi.fn(),
}));

const KEY = 'vk-quota-test';
const KEY_ID = 'vk-quota';
const OTHER_KEY_ID = 'vk-other';
const NOW = new Date('2026-03-02T12:00:00+08:00').getTime();

function virtualKeyOf(id: string) {
  return { id, key_value: KEY, enabled: 1, rate_limit: null };
}

function makeRequestReply(model = 'gpt-x') {
  const request: any = {
    headers: { authorization: `Bearer ${KEY}` },
    body: { model },
    url: '/v1/chat/completions',
    socket: { remoteAddress: '127.0.0.1' },
  };
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
  return { request, reply };
}

function makeHandlers() {
  return {
    onAntiBotBlock: vi.fn(),
    onAuthError: vi.fn(),
    onRateLimited: vi.fn(),
    // Mirrors the OpenAI protocol handler: the payload must key off `period`.
    onQuotaExceeded: vi.fn(
      ({ reply, modelName, retryAfterSeconds, period }: any) => {
        const weekly = period === 'weekly';
        reply.code(429).send({
          error: {
            message: `Model "${modelName}" has reached this virtual key's ${weekly ? 'weekly' : 'daily'} token quota. Retry after ${formatRetryDuration(retryAfterSeconds)}.`,
            type: 'rate_limit_error',
            param: 'model',
            code: weekly
              ? 'model_weekly_token_quota_exceeded'
              : 'model_daily_token_quota_exceeded',
          },
        });
      },
    ),
    onModelError: vi.fn(),
    onProviderConfigError: vi.fn(),
  };
}

async function run(model?: string) {
  const { request, reply } = makeRequestReply(model);
  const handlers = makeHandlers();
  const result = await runProxyPipeline(request, reply, {
    protocol: 'openai',
    handlers,
  });
  return { request, reply, handlers, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  virtualKeyRateLimiter.reset();
  virtualKeyQuota.resetForTesting();
  // 两把密钥都给 gpt-x 配 1M：同一模型、各自的预算（per-key 契约的核心）。
  mocks.getAll.mockResolvedValue([
    { virtualKeyId: KEY_ID, model: 'gpt-x', limitMillions: 1 },
    { virtualKeyId: OTHER_KEY_ID, model: 'gpt-x', limitMillions: 1 },
  ]);
  mocks.getByVirtualKeyId.mockResolvedValue([]);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
  mocks.renameDayUsage.mockResolvedValue(undefined);
  mocks.deleteBefore.mockResolvedValue(undefined);
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue(
    virtualKeyOf(KEY_ID) as any,
  );
  vi.mocked(resolveModelAndProvider).mockResolvedValue({
    provider: { id: 'p1', name: 'p1' },
    providerId: 'p1',
    currentModel: { id: 'm1', name: 'gpt-x', model_identifier: 'gpt-x-real' },
    modelId: 'm1',
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { baseUrl: 'https://example.invalid', apiKey: 'k' },
    path: '/v1/chat/completions',
    vkDisplay: 'vk',
    isStreamRequest: false,
  } as any);
});

afterEach(() => {
  vi.useRealTimers();
});

test('a model under its daily ceiling continues to provider config build', async () => {
  const { reply, handlers, result } = await run('gpt-x');

  expect(result.ok).toBe(true);
  expect(handlers.onQuotaExceeded).not.toHaveBeenCalled();
  expect(reply.code).not.toHaveBeenCalled();
  expect(buildProviderConfig).toHaveBeenCalled();
});

test('an exhausted model gets 429 + Retry-After before any upstream work', async () => {
  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_200_000, NOW);

  const { reply, handlers, result } = await run('gpt-x');

  expect(result.ok).toBe(false);
  expect(buildProviderConfig).not.toHaveBeenCalled();
  expect(reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  expect(handlers.onQuotaExceeded).toHaveBeenCalledTimes(1);
  expect(handlers.onQuotaExceeded).toHaveBeenCalledWith(
    expect.objectContaining({
      virtualKeyId: KEY_ID,
      modelName: 'gpt-x',
      period: 'daily',
      limitTokens: 1_000_000,
      usedTokens: 1_200_000,
    }),
  );
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({
        type: 'rate_limit_error',
        code: 'model_daily_token_quota_exceeded',
        message: expect.stringContaining("daily token quota"),
      }),
    }),
  );
});

test('an exhausted weekly ceiling reports period weekly through the callback', async () => {
  // 周一到周五的中午：本周只剩今天一格，记 1M 就把 1M 的周额度顶满。
  mocks.getAll.mockResolvedValue([
    { virtualKeyId: KEY_ID, model: 'gpt-x', limitMillions: 0, weeklyLimitMillions: 1 },
  ]);
  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_000_000, NOW);

  const { reply, handlers, result } = await run('gpt-x');

  expect(result.ok).toBe(false);
  expect(buildProviderConfig).not.toHaveBeenCalled();
  expect(handlers.onQuotaExceeded).toHaveBeenCalledTimes(1);
  expect(handlers.onQuotaExceeded).toHaveBeenCalledWith(
    expect.objectContaining({
      virtualKeyId: KEY_ID,
      modelName: 'gpt-x',
      period: 'weekly',
      limitTokens: 1_000_000,
      usedTokens: 1_000_000,
    }),
  );
  expect(reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({
        code: 'model_weekly_token_quota_exceeded',
        message: expect.stringContaining('weekly token quota'),
      }),
    }),
  );
});

test('a daily ceiling trips before the weekly one when both are configured', async () => {
  mocks.getAll.mockResolvedValue([
    { virtualKeyId: KEY_ID, model: 'gpt-x', limitMillions: 1, weeklyLimitMillions: 5 },
  ]);
  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_000_000, NOW);

  const { reply, result } = await run('gpt-x');

  // 日额度先满：即使周额度还剩很多，也应按 daily 报错（与既有行为一致）。
  expect(result.ok).toBe(false);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({ code: 'model_daily_token_quota_exceeded' }),
    }),
  );
});

test('the daily budget belongs to the authenticated virtual key', async () => {
  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_000_000, NOW);

  const blocked = await run('gpt-x');
  expect(blocked.result.ok).toBe(false);
  expect(blocked.handlers.onQuotaExceeded).toHaveBeenCalledWith(
    expect.objectContaining({ virtualKeyId: KEY_ID }),
  );

  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue(
    virtualKeyOf(OTHER_KEY_ID) as any,
  );
  const fresh = await run('gpt-x');

  expect(fresh.result.ok).toBe(true);
  expect(fresh.handlers.onQuotaExceeded).not.toHaveBeenCalled();
  expect(buildProviderConfig).toHaveBeenCalled();
});

test('the quota follows the addressed model name, not the routed real model', async () => {
  // gpt-x 是虚拟模型名，它路由到的 gpt-x-real 自己另算。
  virtualKeyQuota.record(KEY_ID, 'gpt-x-real', 5_000_000, NOW);

  await expect(run('gpt-x').then((r) => r.result.ok)).resolves.toBe(true);

  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_000_000, NOW);
  const { result } = await run('gpt-x');
  expect(result.ok).toBe(false);
});

test('models without a configured ceiling are untouched by the quota', async () => {
  const { result, handlers } = await run('gpt-other');

  expect(result.ok).toBe(true);
  expect(handlers.onQuotaExceeded).not.toHaveBeenCalled();
});

test('an early success hook can enforce an exhausted quota before model resolution', async () => {
  virtualKeyQuota.record(KEY_ID, 'gpt-x', 1_000_000, NOW);
  const { request, reply } = makeRequestReply('gpt-x');
  const handlers = makeHandlers();

  const result = await runProxyPipeline(request, reply, {
    protocol: 'openai',
    handlers,
    afterAuth: async ({ checkQuota }) => {
      if (!(await checkQuota('gpt-x'))) return false;
      throw new Error('an exhausted early response must not continue');
    },
  });

  expect(result.ok).toBe(false);
  expect(handlers.onQuotaExceeded).toHaveBeenCalledTimes(1);
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(resolveModelAndProvider).not.toHaveBeenCalled();
  expect(buildProviderConfig).not.toHaveBeenCalled();
});

test('a gateway-cache hit is charged the name the client sent', async () => {
  // 命中缓存的请求在 afterAuth 就返回了（不跑模型解析），名字必须在解析前就已打点。
  const { request, reply } = makeRequestReply('gpt-x');

  await runWithQuotaContext(async () => {
    await runProxyPipeline(request, reply, {
      protocol: 'openai',
      handlers: makeHandlers(),
      afterAuth: () => false,
    });
    expect(currentQuotaModel()).toBe('gpt-x');
  });
});
