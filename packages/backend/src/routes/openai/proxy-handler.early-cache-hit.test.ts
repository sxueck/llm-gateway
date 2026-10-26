import { beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import Fastify from 'fastify';

import { requestCache } from '../../services/request-cache.js';
import { hotConfigCache } from '../../services/hot-config-cache.js';
import { computeLogicalCacheKey } from '../proxy/cache.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { createOpenAIProxyHandler } from './proxy-handler.js';
import {
  modelDailyQuota,
  runWithQuotaContext,
} from '../../services/model-daily-quota.js';

const quotaMocks = vi.hoisted(() => ({
  get: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  apiRequestDb: { create: vi.fn(async () => {}) },
  systemConfigDb: { get: quotaMocks.get, set: vi.fn() },
  modelDailyUsageDb: {
    addUsage: quotaMocks.addUsage,
    getDayUsage: quotaMocks.getDayUsage,
    getDayTotals: quotaMocks.getDayTotals,
    renameDayUsage: quotaMocks.renameDayUsage,
    deleteBefore: quotaMocks.deleteBefore,
  },
}));
vi.mock('../../services/threat-ip-blocker.js', () => ({
  threatIpBlocker: { isThreat: vi.fn(() => false), refresh: vi.fn() },
}));
vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: { getVirtualKeyByKeyValue: vi.fn() },
}));
vi.mock('../proxy/model-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    // The whole point of the early hit: routing/model resolution must never run.
    resolveModelAndProvider: vi.fn(async () => {
      throw new Error('model resolution must not run on an early cache hit');
    }),
  };
});

const KEY_VALUE = 'sk-early-hit-test-key';
const virtualKey = {
  id: 'vk-early-hit',
  key_value: KEY_VALUE,
  enabled: 1,
  cache_enabled: 1,
  pii_protection_enabled: 0,
};
const requestBody = {
  model: 'glm-4-flash-250414',
  temperature: 0,
  messages: [{ role: 'user', content: '翻译成英文：有志者事竟成。' }],
};
const cachedResponse = {
  id: 'chatcmpl-cached',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Where there is a will, there is a way.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 12, total_tokens: 23 },
};

beforeEach(() => {
  vi.clearAllMocks();
  requestCache.clear();
  modelDailyQuota.resetForTesting();
  quotaMocks.get.mockResolvedValue({
    value: JSON.stringify({ [requestBody.model]: 1, 'gpt-x': 1 }),
  });
  quotaMocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  quotaMocks.getDayTotals.mockResolvedValue([]);
  quotaMocks.addUsage.mockResolvedValue(undefined);
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue(virtualKey as any);
});

test('early cache hit is served in afterAuth, before model resolution and routing', async () => {
  const logicalKey = computeLogicalCacheKey(virtualKey, requestBody, false, false)!;
  requestCache.set(logicalKey, cachedResponse, { 'content-type': 'application/json' }, 60_000);

  const app = Fastify();
  app.post('/v1/chat/completions', createOpenAIProxyHandler());
  const statsBefore = requestCache.getStats();

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: requestBody,
  });
  await app.close();

  expect(res.statusCode).toBe(200);
  expect(res.headers['x-cache-status']).toBe('HIT');
  expect(res.json()).toEqual(cachedResponse);
  expect(resolverCalls()).toBe(0);

  // One counting lookup per request: the served hit. The afterAuth existence
  // probe must stay stats-free (no phantom miss before the real hit).
  const statsAfter = requestCache.getStats();
  expect(statsAfter.hits - statsBefore.hits).toBe(1);
  expect(statsAfter.misses - statsBefore.misses).toBe(0);
});

test('no early hit without a cached entry: model resolution runs as usual', async () => {
  const app = Fastify();
  app.post('/v1/chat/completions', createOpenAIProxyHandler());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: requestBody,
  });
  await app.close();

  // Cache miss must fall through to the normal pipeline (here: the mocked
  // resolver throws), proving the early return only triggers on a real hit.
  expect(resolverCalls()).toBe(1);
  expect(res.statusCode).toBe(500);
});

test('early cache hit is rejected after the cached model exhausts its quota', async () => {
  const logicalKey = computeLogicalCacheKey(virtualKey, requestBody, false, false)!;
  requestCache.set(logicalKey, cachedResponse, { 'content-type': 'application/json' }, 60_000);
  modelDailyQuota.record(requestBody.model, 1_000_000);

  const app = Fastify();
  app.post('/v1/chat/completions', createOpenAIProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: requestBody,
  });
  await app.close();

  expect(res.statusCode).toBe(429);
  expect(res.json().error.code).toBe('model_daily_token_quota_exceeded');
  expect(resolverCalls()).toBe(0);
});

test.each(['gpt-x-high', 'gpt-x-auto-high'])(
  'early cache hit charges the normalized quota identity stored with %s',
  async (model) => {
    const suffixedBody = { ...requestBody, model };
    quotaMocks.get.mockResolvedValue({
      value: JSON.stringify({ 'gpt-x': 1, [model]: 1 }),
    });
    const logicalKey = computeLogicalCacheKey(virtualKey, suffixedBody, false, false)!;
    requestCache.set(
      logicalKey,
      cachedResponse,
      { 'content-type': 'application/json' },
      60_000,
      'gpt-x',
    );

    const app = Fastify();
    app.addHook('onRequest', (_request, _reply, done) => {
      runWithQuotaContext(done);
    });
    app.post('/v1/chat/completions', createOpenAIProxyHandler());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY_VALUE}` },
      payload: suffixedBody,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect((await modelDailyQuota.check('gpt-x')).usedTokens).toBe(23);
    expect((await modelDailyQuota.check(model)).usedTokens).toBe(0);
  },
);

function resolverCalls(): number {
  return (resolveModelAndProvider as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
}
