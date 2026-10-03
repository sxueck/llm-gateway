import { afterEach, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { appConfig } from '../../config/index.js';
import { registerResponsesWebSocketRoutes } from './ws-handler.js';
import { NODE_BOOT_EPOCH, NODE_DISPATCH_PATH, NODE_EPOCH_PATH } from '../../services/node-dispatch.js';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), provider: vi.fn(), build: vi.fn(), audit: vi.fn(), rate: vi.fn(), localTransport: vi.fn(), capture: vi.fn() }));
vi.mock('../proxy/pipeline.js', () => ({ runProxyAuthentication: mocks.auth }));
vi.mock('../proxy/model-resolver.js', () => ({ resolveModelAndProvider: mocks.resolve }));
vi.mock('../proxy/provider-config-builder.js', () => ({ buildProviderConfig: mocks.build }));
vi.mock('../../db/index.js', () => ({ providerDb: { getById: mocks.provider } }));
vi.mock('../../services/api-request-logger.js', () => ({ logApiRequestAsync: mocks.audit }));
vi.mock('../../services/virtual-key-rate-limiter.js', () => ({ virtualKeyRateLimiter: { check: mocks.rate } }));
vi.mock('../../services/prompt-capture-service.js', () => ({ capturePromptSampleAsync: mocks.capture }));
vi.mock('../../services/responses-transport/orchestrator.js', () => ({ runResponsesTransport: mocks.localTransport }));

afterEach(() => vi.clearAllMocks());

test('public WebSocket routes turns to owner, counts RPM once, and never executes or audits on ingress', async () => {
  const owner = Fastify();
  const envelopes: any[] = [];
  owner.get(NODE_EPOCH_PATH, () => ({ nodeId: 'node-b', epoch: NODE_BOOT_EPOCH }));
  owner.post(NODE_DISPATCH_PATH, (request, reply) => {
    envelopes.push(request.body);
    reply.type('application/x-ndjson').send([
      { type: 'response.output_text.delta', delta: { text: 'owner-output' } },
      { type: 'response.completed', response: { id: 'owner-response' } },
      { type: '__stream_result', __result: { terminalEventReceived: true, tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 0 }, transportMode: 'ws_to_http_sse' } },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
  });
  await owner.listen({ port: 0, host: '127.0.0.1' });
  appConfig.node = { enabled: true, id: 'node-a', controlId: 'node-a', peers: { "node-b": owner.listeningOrigin }, secret: "node-test-".repeat(4) };
  mocks.auth.mockResolvedValue({ ok: true, context: { virtualKey: { id: 'vk', rate_limit: 10 }, virtualKeyValue: 'test-key', requestIp: '192.0.2.1', requestUserAgent: 'test-client' } });
  mocks.rate.mockReturnValue({ allowed: true });
  mocks.resolve.mockResolvedValue({ provider: { id: 'provider', owner_node: 'node-b' }, providerId: 'provider', currentModel: { id: 'model', model_identifier: 'upstream-model' } });
  mocks.provider.mockResolvedValue({ id: 'provider', owner_node: 'node-b', enabled: 1 });
  const ingress = Fastify();
  await ingress.register(websocket);
  await ingress.register(registerResponsesWebSocketRoutes);
  await ingress.listen({ port: 0, host: '127.0.0.1' });
  const client = new WebSocket(`${ingress.listeningOrigin.replace('http:', 'ws:')}/v1/responses`);
  const frames: any[] = [];
  try {
    const done = new Promise<void>((resolve, reject) => {
      client.on('error', reject);
      client.on('message', data => {
        const event = JSON.parse(data.toString());
        frames.push(event);
        if (event.type === 'response.completed') resolve();
        if (event.type === 'error') reject(new Error(event.error.message));
      });
      client.on('open', () => client.send(JSON.stringify({ type: 'response.create', response: { model: 'client-model', input: 'test' } })));
    });
    await done;
    expect(frames.map(event => event.type)).toEqual(['response.output_text.delta', 'response.completed']);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].transport).toBe('responses-ws');
    expect(envelopes[0].resolution.providerId).toBe('provider');
    expect(mocks.rate).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.localTransport).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    // Prompt samples are recorded once, at the ingress, even when the turn runs on the owner.
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  } finally {
    if (client.readyState === WebSocket.OPEN) {
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      client.close();
      await closed;
    } else client.terminate();
    await ingress.close();
    await owner.close();
  }
});
