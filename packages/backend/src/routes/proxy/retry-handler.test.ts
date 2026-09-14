import { beforeEach, expect, test, vi } from 'vitest';

import { retrySmartRouting } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { handleNonStreamRequest } from '../openai/proxy-handler.js';
import { handleNonStreamRetry } from './retry-handler.js';

vi.mock('./model-resolver.js', () => ({
  retrySmartRouting: vi.fn(),
}));

vi.mock('./provider-config-builder.js', () => ({
  buildProviderConfig: vi.fn(),
}));

vi.mock('./routing.js', () => ({
  shouldRetrySmartRouting: vi.fn(() => true),
}));

vi.mock('../openai/proxy-handler.js', () => ({
  handleNonStreamRequest: vi.fn(),
  handleStreamRequest: vi.fn(),
  applyOpenAITargetModelMutations: vi.fn(() => ({
    modelAttributes: undefined,
    effectiveMaxCompletionTokens: undefined,
  })),
  cloneOpenAIRetryBody: vi.fn((body: any) => JSON.parse(JSON.stringify(body))),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('preserves forced reasoning effort when smart routing retries', async () => {
  vi.mocked(retrySmartRouting).mockResolvedValue({
    provider: { name: 'fallback-provider' },
    providerId: 'provider-2',
    currentModel: { model_identifier: 'gpt-5' },
    excludeTargetKeys: new Set(['target-1', 'target-2']),
    canRetry: false,
    modelId: 'virtual-model-1',
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { protocol: 'openai', model: 'gpt-5' },
    path: '/v1/chat/completions',
  } as any);

  const request = { body: { model: 'gpt-5' } } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: 'vk-1' },
    virtualKeyValue: 'vk-value',
    vkDisplay: 'vk-value',
    modelResult: {
      provider: { name: 'primary-provider' },
      providerId: 'provider-1',
      excludeTargetKeys: new Set(['target-1']),
      canRetry: true,
      modelId: 'virtual-model-1',
      forcedReasoningEffort: 'max',
    },
    startTime: Date.now(),
    entrypointProtocol: 'openai',
  });

  expect(handleNonStreamRequest).toHaveBeenCalledWith(expect.objectContaining({
    modelResult: expect.objectContaining({ forcedReasoningEffort: 'max' }),
  }));
});

test('smart routing retry replays the pristine body snapshot instead of the first target\'s mutated body', async () => {
  vi.mocked(retrySmartRouting).mockResolvedValue({
    provider: { name: 'fallback-provider' },
    providerId: 'provider-2',
    currentModel: { name: 'model-b', model_identifier: 'model-b' },
    excludeTargetKeys: new Set(['target-1', 'target-2']),
    canRetry: false,
    modelId: 'virtual-model-1',
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { protocol: 'openai', model: 'model-b' },
    path: '/v1/chat/completions',
  } as any);

  // Snapshot captured before target-A mutations: original PII text, no extra_body.
  const retryBodySnapshot = {
    model: 'model-a',
    max_completion_tokens: 4096,
    messages: [{ role: 'user', content: 'reach me at john.doe@example.com' }],
  };
  // request.body as the first attempt left it: PII surrogate + target-A attributes.
  const request = {
    body: {
      model: 'model-a',
      max_completion_tokens: 100,
      messages: [{ role: 'user', content: 'PII_MASKED_1' }],
      extra_body: { enable_thinking: true },
    },
  } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: 'vk-1' },
    virtualKeyValue: 'vk-value',
    vkDisplay: 'vk-value',
    modelResult: {
      provider: { name: 'primary-provider' },
      providerId: 'provider-1',
      excludeTargetKeys: new Set(['target-1']),
      canRetry: true,
      modelId: 'virtual-model-1',
    },
    startTime: Date.now(),
    entrypointProtocol: 'openai',
    retryBodySnapshot,
  });

  // Target B receives the pristine body (fresh clone, not the snapshot reference)
  // with its own model identifier — no PII surrogate, no target-A attributes.
  expect(request.body).toEqual({
    model: 'model-b',
    max_completion_tokens: 4096,
    messages: [{ role: 'user', content: 'reach me at john.doe@example.com' }],
  });
  expect(request.body).not.toBe(retryBodySnapshot);
  // The snapshot itself stays pristine for a potential target-C retry.
  expect(retryBodySnapshot.model).toBe('model-a');
  expect(retryBodySnapshot.messages[0].content).toBe('reach me at john.doe@example.com');

  const { applyOpenAITargetModelMutations } = await import('../openai/proxy-handler.js');
  expect(applyOpenAITargetModelMutations).toHaveBeenCalledWith(request, expect.objectContaining({ model_identifier: 'model-b' }));
  expect(handleNonStreamRequest).toHaveBeenCalledWith(expect.objectContaining({ retryBodySnapshot }));
});

test('smart routing retry keeps legacy mutated-body behavior when no snapshot is available', async () => {
  vi.mocked(retrySmartRouting).mockResolvedValue({
    provider: { name: 'fallback-provider' },
    providerId: 'provider-2',
    currentModel: { name: 'model-b', model_identifier: 'model-b' },
    excludeTargetKeys: new Set(['target-1', 'target-2']),
    canRetry: false,
    modelId: 'virtual-model-1',
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { protocol: 'openai', model: 'model-b' },
    path: '/v1/chat/completions',
  } as any);

  const request = {
    body: {
      model: 'model-a',
      messages: [{ role: 'user', content: 'PII_MASKED_1' }],
    },
  } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: 'vk-1' },
    virtualKeyValue: 'vk-value',
    vkDisplay: 'vk-value',
    modelResult: {
      provider: { name: 'primary-provider' },
      providerId: 'provider-1',
      excludeTargetKeys: new Set(['target-1']),
      canRetry: true,
      modelId: 'virtual-model-1',
    },
    startTime: Date.now(),
    entrypointProtocol: 'openai',
  });

  // No snapshot: only the retry target's model is set, body is otherwise untouched.
  expect(request.body).toEqual({
    model: 'model-b',
    messages: [{ role: 'user', content: 'PII_MASKED_1' }],
  });
  expect(handleNonStreamRequest).toHaveBeenCalledWith(expect.objectContaining({
    retryBodySnapshot: undefined,
  }));
});
