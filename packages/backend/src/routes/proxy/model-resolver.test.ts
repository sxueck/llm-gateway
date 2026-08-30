import { beforeEach, expect, test, vi } from 'vitest';

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { reasoningEffortSuffixesCache } from '../../services/reasoning-effort-suffixes.js';
import { resolveProviderFromModel } from './routing.js';
import { parseModelSuffix, resolveModelAndProvider } from './model-resolver.js';
import {
  DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES,
} from '../../services/reasoning-effort-suffixes.js';

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
