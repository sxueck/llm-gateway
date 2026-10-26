import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import {
  currentQuotaModel,
  modelDailyQuota,
  runWithQuotaContext,
} from '../../services/model-daily-quota.js';
import { runProxyPipeline } from './pipeline.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  systemConfigDb: { get: mocks.get, set: mocks.set },
  modelDailyUsageDb: {
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
const NOW = new Date('2026-03-02T12:00:00+08:00').getTime();

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
    onQuotaExceeded: vi.fn(({ reply, modelName, limitTokens, usedTokens }: any) => {
      reply.code(429).send({
        error: {
          message: `Model "${modelName}" has used ${usedTokens} of its ${limitTokens} daily token quota.`,
          type: 'rate_limit_error',
          param: 'model',
          code: 'model_daily_token_quota_exceeded',
        },
      });
    }),
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
  modelDailyQuota.resetForTesting();
  mocks.get.mockResolvedValue({ value: JSON.stringify({ 'gpt-x': 1 }) } as any);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
  mocks.renameDayUsage.mockResolvedValue(undefined);
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    id: 'vk-quota',
    key_value: KEY,
    enabled: 1,
    rate_limit: null,
  } as any);
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
  modelDailyQuota.record('gpt-x', 1_200_000, NOW);

  const { reply, handlers, result } = await run('gpt-x');

  expect(result.ok).toBe(false);
  expect(buildProviderConfig).not.toHaveBeenCalled();
  expect(reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  expect(handlers.onQuotaExceeded).toHaveBeenCalledTimes(1);
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({
        type: 'rate_limit_error',
        code: 'model_daily_token_quota_exceeded',
      }),
    }),
  );
});

test('the quota follows the addressed model name, not the routed real model', async () => {
  // gpt-x 是虚拟模型名，它路由到的 gpt-x-real 自己另算。
  modelDailyQuota.record('gpt-x-real', 5_000_000, NOW);

  await expect(run('gpt-x').then((r) => r.result.ok)).resolves.toBe(true);

  modelDailyQuota.record('gpt-x', 1_000_000, NOW);
  const { result } = await run('gpt-x');
  expect(result.ok).toBe(false);
});

test('models without a configured ceiling are untouched by the quota', async () => {
  const { result, handlers } = await run('gpt-other');

  expect(result.ok).toBe(true);
  expect(handlers.onQuotaExceeded).not.toHaveBeenCalled();
});

test('an early success hook can enforce an exhausted quota before model resolution', async () => {
  modelDailyQuota.record('gpt-x', 1_000_000, NOW);
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
