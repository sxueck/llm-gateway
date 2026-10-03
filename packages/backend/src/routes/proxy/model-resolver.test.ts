import { beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import { modelDb } from '../../db/index.js';
import { hotConfigCache } from '../../services/hot-config-cache.js';
import { reasoningEffortSuffixesCache } from '../../services/reasoning-effort-suffixes.js';
import {
  AGENT_LOOPBACK_HEADER,
  agentLoopbackToken,
} from '../../agent/run/loopback-token.js';
import { resolveProviderFromModel } from './routing.js';
import { parseModelSuffix, resolveModelAndProvider } from './model-resolver.js';
import {
  DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES,
} from '../../services/reasoning-effort-suffixes.js';

vi.mock('../../db/index.js', () => ({
  systemConfigDb: { get: vi.fn() },
  modelDb: { getByName: vi.fn() },
}));

vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: {
    getModelById: vi.fn(),
    getProviderById: vi.fn(),
  },
}));

vi.mock('../../services/reasoning-effort-suffixes.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/reasoning-effort-suffixes.js')>(),
  reasoningEffortSuffixesCache: { getSuffixes: vi.fn() },
}));

vi.mock('./routing.js', () => ({
  resolveProviderFromModel: vi.fn(),
}));

const DEFAULT_SUFFIXES = [...DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES];

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── parseModelSuffix ──────────────────────────────────────────────────────

test('parses valid suffix from model name', () => {
  expect(parseModelSuffix('gpt-5.6-luna-high', DEFAULT_SUFFIXES)).toEqual({
    baseModel: 'gpt-5.6-luna',
    reasoningEffort: 'high',
  });
});

test('parses suffix from simple model name', () => {
  expect(parseModelSuffix('gpt-5-high', DEFAULT_SUFFIXES)).toEqual({
    baseModel: 'gpt-5',
    reasoningEffort: 'high',
  });
});

test('returns null when suffix is not in whitelist', () => {
  expect(parseModelSuffix('deepseek-v4-pro-ultra', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns null when there is no dash', () => {
  expect(parseModelSuffix('gpt5', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns null when prefix would be empty (leading dash)', () => {
  expect(parseModelSuffix('-max', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns null when suffix would be empty (trailing dash)', () => {
  expect(parseModelSuffix('gpt-5-', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns null for empty model name', () => {
  expect(parseModelSuffix('', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns null when whitelist is empty', () => {
  expect(parseModelSuffix('gpt-5-max', [])).toBeNull();
});

test('returns null when whitelist is undefined', () => {
  expect(parseModelSuffix('gpt-5-max', undefined as any)).toBeNull();
});

test('splits on last dash only', () => {
  expect(parseModelSuffix('a-b-c-low', DEFAULT_SUFFIXES)).toEqual({
    baseModel: 'a-b-c',
    reasoningEffort: 'low',
  });
});

test('parses "minimal" suffix', () => {
  expect(parseModelSuffix('gpt-5-minimal', DEFAULT_SUFFIXES)).toEqual({
    baseModel: 'gpt-5',
    reasoningEffort: 'minimal',
  });
});

test('parses "none" suffix (disable thinking)', () => {
  expect(parseModelSuffix('glm5.3-none', DEFAULT_SUFFIXES)).toEqual({
    baseModel: 'glm5.3',
    reasoningEffort: 'none',
  });
});

test('suffix match is case-sensitive', () => {
  expect(parseModelSuffix('gpt-5-Max', DEFAULT_SUFFIXES)).toBeNull();
});

test('returns an OpenAI 400 invalid_request_error when routing strategy conflicts with a pinned model', async () => {
  const model = { id: 'model-1', name: 'gpt-5', model_identifier: 'gpt-5', provider_id: 'provider-1' };
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(model as any);
  vi.mocked(resolveProviderFromModel).mockRejectedValue(Object.assign(
    new Error('Routing strategy is not applicable to a pinned model target'),
    { statusCode: 400, code: 'invalid_routing_strategy' },
  ));
  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_id: 'model-1' },
    { body: { model: 'gpt-5', routing: 'price' }, headers: {}, protocol: 'openai', url: '/v1/chat/completions' } as any,
    'vk-value',
  );
  expect(result).toMatchObject({
    code: 400,
    body: { error: { type: 'invalid_request_error', code: 'invalid_routing_strategy', param: null } },
  });
});

test('resolves a suffix request to its base model and records the forced effort', async () => {
  const model = { id: 'model-1', name: 'gpt-5', model_identifier: 'gpt-5', provider_id: 'provider-1' };
  const provider = { id: 'provider-1', name: 'provider-1' };
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['high']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(model as any);
  vi.mocked(hotConfigCache.getProviderById).mockResolvedValue(provider as any);
  vi.mocked(resolveProviderFromModel).mockResolvedValue({ provider, providerId: 'provider-1' } as any);

  const request = {
    body: { model: 'gpt-5-high' },
    headers: {},
    protocol: 'openai',
    url: '/v1/chat/completions',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect(request.body).toMatchObject({ model: 'gpt-5', reasoning_effort: 'high' });
  expect(result).toMatchObject({ forcedReasoningEffort: 'high' });
});

test('resolves a suffix request on the Responses API entry to reasoning.effort', async () => {
  const model = { id: 'model-1', name: 'gpt-5', model_identifier: 'gpt-5', provider_id: 'provider-1' };
  const provider = { id: 'provider-1', name: 'provider-1' };
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['high']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(model as any);
  vi.mocked(hotConfigCache.getProviderById).mockResolvedValue(provider as any);
  vi.mocked(resolveProviderFromModel).mockResolvedValue({ provider, providerId: 'provider-1' } as any);

  const request = {
    body: { model: 'gpt-5-high', stream: true },
    headers: {},
    protocol: 'openai',
    url: '/v1/responses',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect(request.body).toMatchObject({ model: 'gpt-5', stream: true, reasoning: { effort: 'high' } });
  expect(request.body.reasoning_effort).toBeUndefined();
  expect(result).toMatchObject({ forcedReasoningEffort: 'high' });
});

test('suffix effort merges into an existing Responses reasoning object', async () => {
  const model = { id: 'model-1', name: 'gpt-5', model_identifier: 'gpt-5', provider_id: 'provider-1' };
  const provider = { id: 'provider-1', name: 'provider-1' };
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['low']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(model as any);
  vi.mocked(hotConfigCache.getProviderById).mockResolvedValue(provider as any);
  vi.mocked(resolveProviderFromModel).mockResolvedValue({ provider, providerId: 'provider-1' } as any);

  const request = {
    body: { model: 'gpt-5-low', reasoning: { effort: 'high', summary: 'auto' } },
    headers: {},
    protocol: 'openai',
    url: '/v1/responses',
  } as any;

  await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect(request.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
});

test('suffix parsing stays disabled for the Responses compact entry', async () => {
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['high']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(undefined as any);

  const request = {
    body: { model: 'gpt-5-high' },
    headers: {},
    protocol: 'openai',
    url: '/v1/responses/compact',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect((result as any).code).toBe(404);
});

test('suffix parsing stays disabled for non chat/responses OpenAI endpoints', async () => {
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['high']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(undefined as any);

  const request = {
    body: { model: 'gpt-5-high' },
    headers: {},
    protocol: 'openai',
    url: '/v1/embeddings',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect((result as any).code).toBe(404);
});

test('skips forced effort when the matched model has disable_thinking', async () => {
  const model = {
    id: 'model-1',
    name: 'gpt-5',
    model_identifier: 'gpt-5',
    provider_id: 'provider-1',
    model_attributes: JSON.stringify({ disable_thinking: true }),
  };
  const provider = { id: 'provider-1', name: 'provider-1' };
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue(['high']);
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(model as any);
  vi.mocked(hotConfigCache.getProviderById).mockResolvedValue(provider as any);
  vi.mocked(resolveProviderFromModel).mockResolvedValue({ provider, providerId: 'provider-1' } as any);

  const request = {
    body: { model: 'gpt-5-high' },
    headers: {},
    protocol: 'openai',
    url: '/v1/chat/completions',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  // 路由仍落到基础模型，但不注入/强制 reasoning_effort，避免绕过 disable_thinking
  expect(request.body).toEqual({ model: 'gpt-5' });
  expect((result as any).forcedReasoningEffort).toBeUndefined();
});

// ─── agent loopback 旁路 ────────────────────────────────────────────────────

test('agent loopback header resolves a model outside the virtual key allowlist', async () => {
  vi.mocked(modelDb.getByName).mockResolvedValue({
    id: 'model-agent',
    name: 'search-fast',
    model_identifier: 'search-fast',
    provider_id: 'provider-1',
    is_virtual: 0,
  } as any);
  vi.mocked(resolveProviderFromModel).mockResolvedValue({
    provider: { id: 'provider-1', name: 'provider-1' },
    providerId: 'provider-1',
  } as any);

  const request = {
    body: { model: 'search-fast' },
    headers: { [AGENT_LOOPBACK_HEADER]: agentLoopbackToken() },
    protocol: 'openai',
    url: '/v1/chat/completions',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect(modelDb.getByName).toHaveBeenCalledWith('search-fast');
  expect((result as any).modelId).toBe('model-agent');
  expect((result as any).code).toBeUndefined();
});

test('forged agent loopback header stays on the allowlist path', async () => {
  vi.mocked(hotConfigCache.getModelById).mockResolvedValue(undefined as any);
  vi.mocked(reasoningEffortSuffixesCache.getSuffixes).mockReturnValue([]);

  const request = {
    body: { model: 'search-fast' },
    headers: { [AGENT_LOOPBACK_HEADER]: 'forged-token' },
    protocol: 'openai',
    url: '/v1/chat/completions',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect((result as any).code).toBe(404);
  expect(modelDb.getByName).not.toHaveBeenCalled();
});

test('agent loopback returns 404 when the profile model is missing or disabled', async () => {
  vi.mocked(modelDb.getByName).mockResolvedValue(undefined as any);

  const request = {
    body: { model: 'search-fast' },
    headers: { [AGENT_LOOPBACK_HEADER]: agentLoopbackToken() },
    protocol: 'openai',
    url: '/v1/chat/completions',
  } as any;

  const result = await resolveModelAndProvider(
    { id: 'vk-1', model_ids: JSON.stringify(['model-1']) },
    request,
    'vk-value'
  );

  expect((result as any).code).toBe(404);
});
