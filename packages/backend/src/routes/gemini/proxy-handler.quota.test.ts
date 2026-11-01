import { beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import Fastify from 'fastify';

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { virtualKeyQuota } from '../../services/virtual-key-quota.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { createGeminiProxyHandler } from './proxy-handler.js';

const quotaMocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getByVirtualKeyId: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  apiRequestDb: { create: vi.fn(async () => {}) },
  systemConfigDb: { get: vi.fn(), set: vi.fn() },
  virtualKeyModelQuotaDb: {
    getAll: quotaMocks.getAll,
    getByVirtualKeyId: quotaMocks.getByVirtualKeyId,
  },
  virtualKeyModelUsageDb: {
    addUsage: quotaMocks.addUsage,
    getDayUsage: quotaMocks.getDayUsage,
    getDayTotals: quotaMocks.getDayTotals,
    renameDayUsage: quotaMocks.renameDayUsage,
    deleteBefore: quotaMocks.deleteBefore,
  },
}));
vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: { getVirtualKeyByKeyValue: vi.fn() },
}));
vi.mock('../proxy/model-resolver.js', () => ({
  resolveModelAndProvider: vi.fn(),
}));
vi.mock('../proxy/provider-config-builder.js', () => ({
  buildProviderConfig: vi.fn(),
}));

const KEY_VALUE = 'sk-gemini-quota-test-key';
const virtualKey = { id: 'vk-gemini-quota', key_value: KEY_VALUE, enabled: 1 };
const MODEL = 'gemini-x';
const requestBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  virtualKeyQuota.resetForTesting();
  quotaMocks.getAll.mockResolvedValue([]);
  quotaMocks.getByVirtualKeyId.mockResolvedValue([]);
  quotaMocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  quotaMocks.getDayTotals.mockResolvedValue([]);
  quotaMocks.addUsage.mockResolvedValue(undefined);
  quotaMocks.renameDayUsage.mockResolvedValue(undefined);
  quotaMocks.deleteBefore.mockResolvedValue(undefined);
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue(virtualKey as any);
  vi.mocked(resolveModelAndProvider).mockResolvedValue({
    provider: { id: 'p1' },
    providerId: 'p1',
    currentModel: { id: 'm1', name: MODEL },
    addressedModelName: MODEL,
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { baseUrl: 'https://upstream.example', apiKey: 'k' },
    path: '/v1beta/models/gemini-x:generateContent',
    vkDisplay: 'vk',
    isStreamRequest: false,
  } as any);
});

async function injectQuotaBlocked() {
  const app = Fastify();
  app.post('/v1beta/models/:modelSpec', createGeminiProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: `/v1beta/models/${MODEL}:generateContent`,
    headers: {
      'x-goog-api-key': KEY_VALUE,
      'content-type': 'application/json',
    },
    payload: requestBody,
  });
  await app.close();
  return res;
}

test('weekly ceiling trips the weekly code and message', async () => {
  quotaMocks.getAll.mockResolvedValue([
    { virtualKeyId: virtualKey.id, model: MODEL, limitMillions: 0, weeklyLimitMillions: 1 },
  ]);
  virtualKeyQuota.record(virtualKey.id, MODEL, 1_000_000);

  const res = await injectQuotaBlocked();

  expect(res.statusCode).toBe(429);
  expect(res.json().error.code).toBe('model_weekly_token_quota_exceeded');
  expect(res.json().error.message).toContain('weekly token quota');
  expect(res.json().error.status).toBe('RESOURCE_EXHAUSTED');
  expect(buildProviderConfig).not.toHaveBeenCalled();
});

test('daily ceiling keeps the historical daily code', async () => {
  quotaMocks.getAll.mockResolvedValue([
    { virtualKeyId: virtualKey.id, model: MODEL, limitMillions: 1, weeklyLimitMillions: 5 },
  ]);
  virtualKeyQuota.record(virtualKey.id, MODEL, 1_000_000);

  const res = await injectQuotaBlocked();

  expect(res.statusCode).toBe(429);
  expect(res.json().error.code).toBe('model_daily_token_quota_exceeded');
  expect(res.json().error.message).toContain('daily token quota');
  expect(buildProviderConfig).not.toHaveBeenCalled();
});
