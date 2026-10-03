import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerResponsesWebSocketRoutes } from './ws-handler.js';
import { runProxyPreflight } from '../proxy/pipeline.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { hotConfigCache } from '../../services/hot-config-cache.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { runResponsesTransport } from '../../services/responses-transport/orchestrator.js';

vi.mock('../../services/anti-bot.js', () => ({
  antiBotService: { detect: () => ({ shouldBlock: false }), logDetection: vi.fn() },
}));
vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: { getVirtualKeyByKeyValue: vi.fn() },
}));
vi.mock('../proxy/model-resolver.js', () => ({ resolveModelAndProvider: vi.fn() }));
vi.mock('../proxy/provider-config-builder.js', () => ({ buildProviderConfig: vi.fn() }));
vi.mock('../../services/api-request-logger.js', () => ({ logApiRequestAsync: vi.fn() }));
vi.mock('../../services/prompt-capture-service.js', () => ({ capturePromptSampleAsync: vi.fn() }));
vi.mock('../../services/debug-mode.js', () => ({ debugModeService: { isActive: () => false } }));
vi.mock('../../services/logger.js', () => ({
  memoryLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/responses-transport/orchestrator.js', () => ({ runResponsesTransport: vi.fn() }));

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function makeRequest() {
  return {
    headers: { authorization: 'Bearer vk-ws-test' },
    url: '/v1/responses',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function makeReply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
}

async function openSocket() {
  const routes = new Map<string, any>();
  await registerResponsesWebSocketRoutes({
    get(path: string, options: any, handler: any) {
      routes.set(path, { options, handler });
    },
  } as any);
  const route = routes.get('/v1/responses');
  const request = makeRequest();
  const reply = makeReply();
  await route.options.preHandler(request, reply);
  expect(reply.send).not.toHaveBeenCalled();
  const socket = new TestSocket();
  const active = route.handler(socket, request);
  return { socket, active };
}

function createResponse(socket: TestSocket) {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'response.create',
    response: { model: 'test-model', input: 'hello' },
  })), false);
}

function frames(socket: TestSocket) {
  return socket.send.mock.calls.map(([frame]) => JSON.parse(frame));
}

beforeEach(() => {
  vi.clearAllMocks();
  virtualKeyRateLimiter.reset();
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    id: 'vk-ws-rate', enabled: 1, rate_limit: 1,
  } as any);
  vi.mocked(resolveModelAndProvider).mockResolvedValue({
    provider: { id: 'provider-test' }, providerId: 'provider-test',
  } as any);
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: {
      baseUrl: 'https://upstream.example/v1', apiKey: 'fixture', model: 'test-model',
    },
    path: '/v1/responses',
  } as any);
  vi.mocked(runResponsesTransport).mockImplementation(async function* () {
    yield { type: 'response.completed', response: { id: 'response-test' } } as any;
    return {
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
      terminalEventReceived: true,
      transportMode: 'ws_to_http_sse' as const,
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  virtualKeyRateLimiter.reset();
});

test('limits each WebSocket turn, keeps the connection open, and re-admits after the window', async () => {
  const { socket, active } = await openSocket();
  try {
    socket.emit('message', Buffer.from('{"type":"response.cancel"}'), false);
    expect(frames(socket)[0].error.code).toBe('nothing_to_cancel');

    createResponse(socket);
    await vi.waitFor(() => expect(logApiRequestAsync).toHaveBeenCalledTimes(1));
    expect(frames(socket)[1].type).toBe('response.completed');

    createResponse(socket);
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(3));
    expect(frames(socket)[2]).toMatchObject({
      type: 'error', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
    expect(runResponsesTransport).toHaveBeenCalledTimes(1);
    expect(resolveModelAndProvider).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
    createResponse(socket);
    await vi.waitFor(() => expect(logApiRequestAsync).toHaveBeenCalledTimes(2));
    expect(runResponsesTransport).toHaveBeenCalledTimes(2);
    expect(frames(socket)[3].type).toBe('response.completed');
  } finally {
    socket.close();
    await active;
  }
});

test('HTTP and WebSocket turns share the same key budget without charging the handshake', async () => {
  const request = makeRequest();
  const reply = makeReply();
  const handlers = {
    onAntiBotBlock: vi.fn(), onAuthError: vi.fn(), onRateLimited: vi.fn(),
  };
  expect((await runProxyPreflight(request, reply as any, handlers)).ok).toBe(true);

  const { socket, active } = await openSocket();
  try {
    createResponse(socket);
    await vi.waitFor(() => expect(frames(socket)).toHaveLength(1));
    expect(frames(socket)[0]).toMatchObject({
      type: 'error', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
    expect(resolveModelAndProvider).not.toHaveBeenCalled();
    expect(runResponsesTransport).not.toHaveBeenCalled();
    expect(logApiRequestAsync).not.toHaveBeenCalled();
  } finally {
    socket.close();
    await active;
  }
});
