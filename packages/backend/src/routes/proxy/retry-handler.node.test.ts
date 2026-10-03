import { beforeEach, expect, test, vi } from 'vitest';
import { appConfig } from '../../config/index.js';
import { handleNonStreamRetry, handleStreamRetry, type RetryContext } from './retry-handler.js';

const mocks = vi.hoisted(() => ({ retry: vi.fn(), provider: vi.fn(), build: vi.fn(), forward: vi.fn() }));
vi.mock('./routing.js', () => ({ shouldRetrySmartRouting: (status: number) => status === 503 }));
vi.mock('./model-resolver.js', () => ({ retrySmartRouting: mocks.retry }));
vi.mock('./provider-config-builder.js', () => ({ buildProviderConfig: mocks.build }));
vi.mock('../../db/index.js', () => ({ providerDb: { getById: mocks.provider } }));
vi.mock('../../services/node-dispatch.js', () => ({
  isRemoteProvider: (provider: { owner_node?: string }) => provider.owner_node === 'node-b',
  forwardToOwner: mocks.forward,
}));

function context(): RetryContext {
  return {
    virtualKey: { id: 'vk' }, virtualKeyValue: 'test-key', vkDisplay: 'test', startTime: Date.now(),
    modelResult: { provider: {}, providerId: 'first-provider', canRetry: true, modelId: 'virtual-model', excludeTargetKeys: new Set(['first-provider::first-model']), routeInfo: { expertRoutingId: 'expert', routeSource: 'jev', logId: 'decision', routedModelName: 'logical-model' } },
    retryBodySnapshot: { model: 'first-model', messages: [{ role: 'user', content: 'pristine' }], max_tokens: 100 },
    logicalCacheKey: 'logical-cache', entrypointProtocol: 'openai',
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  appConfig.node = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": 'https://node-b.example.test' }, secret: "node-test-".repeat(4) };
  mocks.retry.mockResolvedValue({ provider: { id: 'next-provider' }, providerId: 'next-provider', currentModel: { id: 'next-model', model_identifier: 'next-upstream', is_virtual: 0 }, canRetry: true, modelId: 'virtual-model', excludeTargetKeys: new Set(['first-provider::first-model', 'next-provider::next-upstream']) });
  mocks.provider.mockResolvedValue({ id: 'next-provider', owner_node: 'node-b', enabled: 1 });
  mocks.forward.mockResolvedValue(true);
});

test('cross-owner retry forwards a pristine, normalized attempt without building a local upstream client', async () => {
  const ctx = context();
  const request: any = { body: { model: 'first-model', messages: [{ role: 'user', content: 'masked' }], max_tokens: 5 } };
  const reply: any = { sent: false, raw: { headersSent: false } };
  expect(await handleNonStreamRetry(request, reply, 503, ctx)).toBe(true);
  expect(request.body.messages[0].content).toBe('pristine');
  expect(request.body.max_tokens).toBe(100);
  expect(request.body.model).toBe('next-upstream');
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.forward).toHaveBeenCalledWith(request, reply, 'openai', ctx.virtualKey,
    expect.objectContaining({ provider: expect.objectContaining({ owner_node: 'node-b' }), routeInfo: ctx.modelResult.routeInfo }),
    expect.objectContaining({ normalized: true, logicalCacheKey: 'logical-cache', startedAt: ctx.startTime }));
});

test('an already-started stream cannot be moved to a different owner', async () => {
  expect(await handleStreamRetry({} as any, { sent: false, raw: { headersSent: true } } as any, 503, context())).toBe(false);
  expect(mocks.retry).not.toHaveBeenCalled();
  expect(mocks.forward).not.toHaveBeenCalled();
});

test('retry window remains bounded across nodes', async () => {
  const ctx = context();
  ctx.startTime = Date.now() - 10_001;
  expect(await handleNonStreamRetry({} as any, { sent: false, raw: { headersSent: false } } as any, 503, ctx)).toBe(false);
  expect(mocks.retry).not.toHaveBeenCalled();
});
