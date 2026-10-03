import { beforeEach, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import { appConfig } from '../config/index.js';
import { nodeRoutes } from './node.js';
import { runProxyPipeline } from './proxy/pipeline.js';
import { NODE_DISPATCH_PATH, getNodeRequestState, signNodeEnvelope, type NodeEnvelope } from '../services/node-dispatch.js';
import type { NodeConfig } from '../config/node.js';
import { circuitBreaker } from '../services/circuit-breaker.js';
import { agentRunIdFromHeaders } from '../agent/run/loopback-token.js';

const mocks = vi.hoisted(() => ({
  handler: vi.fn(), provider: vi.fn(), key: vi.fn(), model: vi.fn(), resolver: vi.fn(),
  builder: vi.fn(), rate: vi.fn(), audit: vi.fn(), afterAuth: vi.fn(), retry: vi.fn(), capture: vi.fn(), auth: vi.fn(),
}));
vi.mock('../db/index.js', () => ({ providerDb: { getById: mocks.provider }, virtualKeyDb: { getById: mocks.key }, modelDb: { getById: mocks.model } }));
vi.mock('./proxy/model-resolver.js', () => ({ resolveModelAndProvider: mocks.resolver, retrySmartRouting: mocks.retry }));
vi.mock('./proxy/auth.js', () => ({ extractVirtualKeyAuthHeader: (headers: Record<string, string>) => headers.authorization, authenticateVirtualKey: mocks.auth }));
vi.mock('../services/anti-bot.js', () => ({ antiBotService: { detect: () => ({ shouldBlock: false }), logDetection: vi.fn() } }));
vi.mock('../services/prompt-capture-service.js', () => ({ capturePromptSampleAsync: mocks.capture }));
vi.mock('./proxy/provider-config-builder.js', () => ({ buildProviderConfig: mocks.builder }));
vi.mock('../services/virtual-key-rate-limiter.js', () => ({ virtualKeyRateLimiter: { check: mocks.rate } }));
vi.mock('../services/api-request-logger.js', () => ({ logApiRequestAsync: mocks.audit }));
vi.mock('./openai/proxy-handler.js', () => ({ createOpenAIProxyHandler: () => mocks.handler }));
vi.mock('./openai/decisions-handler.js', () => ({ createDecisionsProxyHandler: () => mocks.handler }));
vi.mock('./anthropic/proxy-handler.js', () => ({ createAnthropicProxyHandler: () => mocks.handler }));
vi.mock('./gemini/proxy-handler.js', () => ({ createGeminiProxyHandler: () => mocks.handler }));
vi.mock('../services/responses-transport/orchestrator.js', () => ({
  runResponsesTransport: async function* () {
    yield { type: 'response.completed', response: { id: 'test-response' } };
    yield { type: '__stream_result', __result: { terminalEventReceived: true, tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5, cachedTokens: 0 }, transportMode: 'ws_to_http_sse' } };
  },
}));

const source: NodeConfig = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": 'http://127.0.0.1:1' }, secret: "node-test-".repeat(4) };
const owner: NodeConfig = { ...source, id: 'node-b', peers: { "node-a": 'http://127.0.0.1:2' } };
function envelope(overrides: Partial<NodeEnvelope> = {}): NodeEnvelope {
  return {
    protocol: 'openai', transport: 'http', url: '/v1/chat/completions', method: 'POST',
    headers: { 'user-agent': 'test-client', 'x-real-ip': '192.0.2.1' }, body: { model: 'resolved-model', messages: [] },
    virtualKeyId: 'vk', resolution: { providerId: 'foreign-provider', currentModelId: 'model', canRetry: true, excludeTargetKeys: ['foreign-provider::resolved-model'] },
    ingressNode: 'node-a', hops: ['node-a'], startedAt: Date.now(), requestId: 'test-request', normalized: false,
    ...overrides,
  };
}
async function dispatch(payload: NodeEnvelope, headers = signNodeEnvelope(source, 'node-b', JSON.stringify(payload))) {
  const app = Fastify();
  await app.register(nodeRoutes);
  try { return await app.inject({ method: 'POST', url: NODE_DISPATCH_PATH, headers, payload }); }
  finally { await app.close(); }
}
beforeEach(() => {
  vi.clearAllMocks();
  appConfig.node = { ...owner };
  mocks.rate.mockReturnValue({ allowed: true });
  mocks.auth.mockResolvedValue({ virtualKey: { id: 'vk', enabled: 1, cache_enabled: 0 }, virtualKeyValue: 'test-virtual-key' });
  mocks.provider.mockResolvedValue({ id: 'foreign-provider', owner_node: 'node-b', enabled: 1 });
  mocks.key.mockResolvedValue({ id: 'vk', key_value: 'test-virtual-key', enabled: 1, rate_limit: 1, cache_enabled: 0 });
  mocks.model.mockResolvedValue({ id: 'model', model_identifier: 'resolved-model' });
  mocks.builder.mockResolvedValue({ protocolConfig: { model: 'resolved-model', apiKey: 'test-provider-key', provider: 'foreign-provider', upstreamTransport: 'http_sse' }, path: '/v1/responses', vkDisplay: 'test', isStreamRequest: false });
  mocks.handler.mockImplementation(async (request, reply) => {
    const result = await runProxyPipeline(request, reply, {
      protocol: 'openai', afterAuth: mocks.afterAuth,
      handlers: { onAntiBotBlock: vi.fn(), onAuthError: vi.fn(), onRateLimited: vi.fn(), onModelError: vi.fn(), onProviderConfigError: ({ reply: r, providerConfigError }) => { r.code(providerConfigError.code).send(providerConfigError.body); } },
    });
    if (!result.ok) return;
    if (result.context.modelResult.excludeTargetKeys) expect(result.context.modelResult.excludeTargetKeys).toBeInstanceOf(Set);
    return reply.send({ path: request.url, method: request.method, body: request.body, provider: result.context.providerId });
  });
});

test('direct owner ingress cannot bypass an open circuit and still counts RPM once', async () => {
  const admission = vi.spyOn(circuitBreaker, 'isAvailable').mockReturnValue(false);
  const app = Fastify();
  app.post('/v1/chat/completions', mocks.handler);
  mocks.resolver.mockResolvedValue({ provider: { owner_node: 'node-b' }, providerId: 'foreign-provider' });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'test' }, headers: { authorization: 'Bearer test-virtual-key', 'x-gateway-node-source': 'forged' } });
    expect(response.statusCode).toBe(503);
    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(mocks.builder).not.toHaveBeenCalled();
  } finally { admission.mockRestore(); await app.close(); }
});

test('direct smart-routing owner does not acquire its already-selected admission twice', async () => {
  const admission = vi.spyOn(circuitBreaker, 'isAvailable').mockReturnValue(false);
  const app = Fastify();
  app.post('/v1/chat/completions', mocks.handler);
  mocks.resolver.mockResolvedValue({ provider: { owner_node: 'node-b' }, providerId: 'foreign-provider', excludeTargetKeys: new Set(['foreign-provider::test']) });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'test' } });
    expect(response.statusCode).toBe(200);
    expect(admission).not.toHaveBeenCalled();
    expect(mocks.builder).toHaveBeenCalledTimes(1);
  } finally { admission.mockRestore(); await app.close(); }
});

test('future peer time cannot extend the owner-local retry window', async () => {
  mocks.handler.mockImplementation(async (request, reply) => reply.send({ startedAt: getNodeRequestState(request)!.envelope.startedAt }));
  const response = await dispatch(envelope({ startedAt: Date.now() + 30_000 }));
  expect(response.statusCode).toBe(200);
  expect(response.json().startedAt).toBeLessThanOrEqual(Date.now());
});

test('RPC envelope overhead does not lower the public HTTP body ceiling', async () => {
  const response = await dispatch(envelope({ body: { model: 'resolved-model', input: 'x'.repeat(10 * 1024 * 1024 - 100) } }));
  expect(response.statusCode).toBe(200);
});

test('remote WebSocket turns cannot bypass an open owner circuit', async () => {
  const admission = vi.spyOn(circuitBreaker, 'isAvailable').mockReturnValue(false);
  try {
    const response = await dispatch(envelope({ transport: 'responses-ws', url: '/v1/responses' }));
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('owner_circuit_open');
    expect(mocks.builder).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  } finally { admission.mockRestore(); }
});

test('owner circuit rejection never opens an upstream request', async () => {
  const admission = vi.spyOn(circuitBreaker, 'isAvailable').mockReturnValue(false);
  try {
    const payload = envelope();
    payload.resolution.canRetry = false;
    const response = await dispatch(payload);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('owner_circuit_open');
    expect(mocks.builder).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
  } finally { admission.mockRestore(); }
});

test('owner circuit rejection selects a fallback without acquiring half-open admission twice', async () => {
  const admission = vi.spyOn(circuitBreaker, 'isAvailable').mockReturnValue(false);
  try {
    const payload = envelope();
    payload.resolution.modelId = 'virtual-model';
    mocks.retry.mockResolvedValue({ providerId: 'fallback-provider', provider: {}, currentModel: { id: 'fallback-model' }, excludeTargetKeys: new Set(['foreign-provider::resolved-model', 'fallback-provider::fallback-model']) });
    mocks.provider.mockImplementation(async (id: string) => ({ id, owner_node: 'node-b', enabled: 1 }));
    const response = await dispatch(payload);
    expect(response.statusCode).toBe(200);
    expect(response.json().provider).toBe('fallback-provider');
    expect(admission).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.builder).toHaveBeenCalledTimes(1);
  } finally { admission.mockRestore(); }
});

test('signed Agent correlation is reissued with owner-local loopback authentication', async () => {
  mocks.handler.mockImplementation(async (request, reply) => reply.send({ runId: agentRunIdFromHeaders(request.headers) }));
  const response = await dispatch(envelope({ agentRunId: 'test-agent-run', clientIp: '192.0.2.3' }));
  expect(response.statusCode).toBe(200);
  expect(response.json().runId).toBe('test-agent-run');
});

test('verified owner dispatch restores original route and bypasses RPM, resolution and preprocessing', async () => {
  const response = await dispatch(envelope());
  expect(response.statusCode).toBe(200);
  expect(response.headers['x-gateway-execution-node']).toBe('node-b');
  expect(response.json()).toEqual({ path: '/v1/chat/completions', method: 'POST', body: { model: 'resolved-model', messages: [] }, provider: 'foreign-provider' });
  expect(mocks.resolver).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
  expect(mocks.afterAuth).not.toHaveBeenCalled();
  expect(mocks.builder).toHaveBeenCalledTimes(1);
});

test('a saturated replay ledger answers 503 and never claims an auth failure', async () => {
  const app = Fastify();
  await app.register(nodeRoutes, { isLedgerSaturated: () => true });
  try {
    const response = await app.inject({ method: 'POST', url: NODE_DISPATCH_PATH, headers: signNodeEnvelope(source, 'node-b', JSON.stringify(envelope())), payload: envelope() });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('node_dispatch_saturated');
    expect(response.headers['x-gateway-node-auth-failed']).toBeUndefined();
    expect(response.headers['retry-after']).toBe('5');
    expect(mocks.handler).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

test('forged headers and body tampering cannot invoke a provider', async () => {
  const payload = envelope();
  const headers = signNodeEnvelope(source, 'node-b', JSON.stringify(payload));
  payload.body = { model: 'tampered' };
  expect((await dispatch(payload, headers)).statusCode).toBe(401);
  expect((await dispatch(envelope(), { 'x-gateway-node-source': 'node-a' })).statusCode).toBe(401);
  expect(mocks.handler).not.toHaveBeenCalled();
});

test('replaying an authenticated envelope is rejected', async () => {
  const payload = envelope();
  const headers = signNodeEnvelope(source, 'node-b', JSON.stringify(payload));
  expect((await dispatch(payload, headers)).statusCode).toBe(200);
  expect((await dispatch(payload, headers)).statusCode).toBe(401);
  expect(mocks.handler).toHaveBeenCalledTimes(1);
});

test('ownership mismatch refuses execution instead of bouncing to another node', async () => {
  mocks.provider.mockResolvedValue({ id: 'foreign-provider', owner_node: 'node-a', enabled: 1 });
  const response = await dispatch(envelope());
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('owner_node_mismatch');
  expect(mocks.handler).not.toHaveBeenCalled();
});

test('a key revoked before owner dispatch cannot execute', async () => {
  mocks.key.mockResolvedValue({ id: 'vk', enabled: 0 });
  expect((await dispatch(envelope())).statusCode).toBe(403);
  expect(mocks.handler).not.toHaveBeenCalled();
});

test('invalid routes, hop chains and missing models are rejected', async () => {
  expect((await dispatch(envelope({ url: '/api/admin/providers' }))).statusCode).toBe(400);
  expect((await dispatch(envelope({ hops: ['node-b'] }))).statusCode).toBe(400);
  expect((await dispatch(envelope({ hops: Array(9).fill('node-a') }))).statusCode).toBe(400);
  mocks.model.mockResolvedValue(undefined);
  expect((await dispatch(envelope())).statusCode).toBe(409);
  expect(mocks.handler).not.toHaveBeenCalled();
});

test('owner executes and audits a remote WebSocket turn once using streaming events', async () => {
  const response = await dispatch(envelope({ transport: 'responses-ws', url: '/v1/responses' }));
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('application/x-ndjson');
  const events = response.body.trim().split('\n').map(line => JSON.parse(line));
  expect(events[0].type).toBe('response.completed');
  expect(events[1].__result.tokenUsage.totalTokens).toBe(5);
  // Prompt samples belong to the ingress turn; the owner must not record them twice.
  expect(mocks.capture).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'foreign-provider', status: 'success', tokenCount: expect.objectContaining({ totalTokens: 5 }) }));
  expect(mocks.resolver).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
});
