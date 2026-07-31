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
