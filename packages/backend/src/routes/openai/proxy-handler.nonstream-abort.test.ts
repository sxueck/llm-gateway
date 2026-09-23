import { beforeEach, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import { handleNonStreamRequest } from './proxy-handler.js';
import { makeHttpRequest } from '../proxy/http-client.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { tryAcquireCacheLock, releaseCacheLock } from '../proxy/cache.js';

vi.mock('../../services/logger.js', () => ({
  memoryLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    getLogs: vi.fn(() => []),
  },
}));

vi.mock('../../db/index.js', () => ({
  apiRequestDb: { create: vi.fn(async () => {}) },
}));

vi.mock('../proxy/pipeline.js', () => ({
  runProxyPipeline: vi.fn(),
}));

vi.mock('../proxy/http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proxy/http-client.js')>();
  return {
    ...actual,
    makeHttpRequest: vi.fn(),
    makeStreamHttpRequest: vi.fn(),
  };
});

vi.mock('../proxy/token-calculator.js', () => ({
  calculateTokensIfNeeded: vi.fn(async () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })),
}));

vi.mock('../../services/api-request-logger.js', () => ({
  logApiRequestAsync: vi.fn(),
}));

vi.mock('../../services/circuit-breaker.js', () => ({
  circuitBreaker: {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
}));

vi.mock('../proxy/handlers/shared.js', () => ({
  shouldLogRequestBody: vi.fn(() => false),
  getModelForLogging: vi.fn((body: any) => body?.model || 'unknown'),
}));

vi.mock('../../services/request-header-forwarding.js', () => ({
  requestHeaderForwardingService: {
    buildForwardedHeaders: vi.fn(() => undefined),
  },
}));

vi.mock('../../services/prompt-capture-service.js', () => ({
  capturePromptSampleAsync: vi.fn(),
}));

function makeCtx() {
  const closeListeners: (() => void)[] = [];
  const raw: any = {
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeListeners.push(cb);
    }),
    writableEnded: false,
  };
  const reply: any = {
    header: vi.fn().mockReturnThis(),
    headers: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
    send: vi.fn(async function (this: any) {
      this.sent = true;
      return this;
    }),
    sent: false,
    raw,
  };
  const request: any = {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {},
    raw: { on: vi.fn() },
    body: { model: 'glm-4-flash', messages: [{ role: 'user', content: 'hi' }] },
  };
  const ctx: any = {
    request,
    reply,
    protocolConfig: {
      provider: 'typesafe',
      apiKey: 'sk-test',
      baseUrl: 'https://upstream.test',
      model: 'glm-4-flash',
      protocol: 'openai',
    },
    path: '/v1/chat/completions',
    virtualKey: { id: 1, key_value: 'vk_test_123456' },
    providerId: 'typesafe',
    startTime: Date.now() - 5,
    currentModel: { id: 7, name: 'Flash', model_identifier: 'glm-4-flash' },
    modelResult: { circuitBreakerKey: 'model-7', canRetry: true },
  };
  return { ctx, reply, closeListeners };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('normal completion registers the close listener on reply.raw and is not aborted by it', async () => {
  vi.mocked(makeHttpRequest).mockResolvedValue({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  } as any);

  const { ctx, reply, closeListeners } = makeCtx();
  await handleNonStreamRequest(ctx);

  expect(requestRawOnNeverRegistered(ctx)).toBe(true);
  expect(reply.raw.on).toHaveBeenCalledWith('close', expect.any(Function));
  expect(closeListeners.length).toBe(1);

  // Node 22 fires IncomingMessage 'close' once the body is fully read; a
  // completed response must not be treated as a client disconnect.
  reply.raw.writableEnded = true;
  closeListeners[0]();

  const signal = vi.mocked(makeHttpRequest).mock.calls[0][6] as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
  expect(reply.send).toHaveBeenCalledTimes(1);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'success' }),
  );
  expect(logApiRequestAsync).not.toHaveBeenCalledWith(
    expect.objectContaining({ errorMessage: 'Client aborted' }),
  );
});

test('client disconnect before completion logs exactly one Client aborted row and skips breaker/retry', async () => {
  let resolveUpstream!: (value: any) => void;
  vi.mocked(makeHttpRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveUpstream = resolve;
      }) as any,
  );

  const { ctx, reply, closeListeners } = makeCtx();
  const cacheKey = 'nonstream-abort-lock-test';
  ctx.virtualKey.cache_enabled = 1;
  ctx.logicalCacheKey = cacheKey;
  const handlerPromise = handleNonStreamRequest(ctx);

  // Real disconnect: socket closed while the reply is still unwritten.
  reply.raw.writableEnded = false;
  closeListeners[0]();

  resolveUpstream!({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { choices: [{ message: { role: 'assistant', content: 'late' } }] },
  } as any);
  await handlerPromise;

  const signal = vi.mocked(makeHttpRequest).mock.calls[0][6] as AbortSignal;
  expect(signal.aborted).toBe(true);
  expect(reply.send).not.toHaveBeenCalled();
  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'error',
      errorMessage: 'Client aborted',
    }),
  );
  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
  const nextOwner = tryAcquireCacheLock(cacheKey);
  expect(nextOwner).not.toBeNull();
  if (nextOwner) releaseCacheLock(cacheKey, nextOwner);
});

function requestRawOnNeverRegistered(ctx: any): boolean {
  return (ctx.request.raw.on as ReturnType<typeof vi.fn>).mock.calls.length === 0;
}

vi.mock('../../utils/ip.js', () => ({
  extractIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../utils/http.js', () => ({
  getRequestUserAgent: vi.fn(() => 'vitest'),
}));
