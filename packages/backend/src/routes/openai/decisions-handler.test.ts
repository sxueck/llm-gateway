import { beforeEach, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import { createDecisionsProxyHandler, stripTrailingV1 } from './decisions-handler.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { makeImageGenerationProxyRequest } from '../proxy/http-client.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';

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

vi.mock('../proxy/pipeline.js', () => ({
  runProxyPipeline: vi.fn(),
}));

vi.mock('../proxy/http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proxy/http-client.js')>();
  return {
    ...actual,
    makeImageGenerationProxyRequest: vi.fn(),
  };
});

vi.mock('../proxy/token-calculator.js', () => ({
  calculateTokensIfNeeded: vi.fn(),
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

vi.mock('../../services/request-header-forwarding.js', () => ({
  requestHeaderForwardingService: {
    buildForwardedHeaders: vi.fn(() => undefined),
  },
}));

vi.mock('../proxy/handlers/shared.js', () => ({
  shouldLogRequestBody: vi.fn(() => false),
  getModelForLogging: vi.fn((body: any) => body?.model || 'unknown'),
}));

vi.mock('../../utils/request-logger.js', () => ({
  truncateRequestBody: vi.fn((body: any) => JSON.stringify(body)),
  truncateResponseBody: vi.fn((body: any) => JSON.stringify(body)),
}));

vi.mock('../../utils/ip.js', () => ({
  extractIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../utils/http.js', () => ({
  getRequestUserAgent: vi.fn(() => 'vitest'),
}));

const PROTOCOL_CONFIG = {
  provider: 'typesafe',
  apiKey: 'sk-typesafe-test',
  baseUrl: 'https://api.typesafe.ai',
  model: 'typesafe-ai/jev',
  protocol: 'openai',
};

function mockPipelineSuccess(protocolConfigPatch: any = {}) {
  vi.mocked(runProxyPipeline).mockResolvedValue({
    ok: true,
    context: {
      requestIp: '127.0.0.1',
      requestUserAgent: 'vitest',
      virtualKey: { id: 1, key_value: 'vk_test_123456' },
      virtualKeyValue: 'vk_test_123456',
      provider: { id: 'p1' },
      providerId: 'typesafe',
      currentModel: { id: 7, name: 'Jev', model_identifier: PROTOCOL_CONFIG.model },
      modelResult: { circuitBreakerKey: 'model-7' },
      configResult: {
        protocolConfig: { ...PROTOCOL_CONFIG, ...protocolConfigPatch },
        path: '/v1/systemone',
        vkDisplay: 'vk_tes...3456',
        isStreamRequest: false,
      },
    },
  } as any);
}

function createRequest(body: any) {
  return {
    method: 'POST',
    url: '/v1/systemone',
    headers: {},
    body,
    raw: { on: vi.fn() },
  } as any;
}

function createReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    sent: false,
  };
  return reply;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(calculateTokensIfNeeded).mockResolvedValue({
    promptTokens: 451,
    completionTokens: 72,
    totalTokens: 523,
  });
});

test('stripTrailingV1 removes trailing /v1 and slashes from chat baseUrls', () => {
  expect(stripTrailingV1('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api');
  expect(stripTrailingV1('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api');
  expect(stripTrailingV1('https://api.typesafe.ai')).toBe('https://api.typesafe.ai');
  expect(stripTrailingV1(undefined)).toBe('');
});

test('missing state returns 400 and never reaches upstream', async () => {
  mockPipelineSuccess();
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ questions: { a: { type: 'noul' } } }), reply);

  expect(reply.code).toHaveBeenCalledWith(400);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_decisions_request', param: 'state' }) })
  );
  expect(makeImageGenerationProxyRequest).not.toHaveBeenCalled();
});

test('empty questions returns 400 and never reaches upstream', async () => {
  mockPipelineSuccess();
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ state: 'hello', questions: {} }), reply);

  expect(reply.code).toHaveBeenCalledWith(400);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_decisions_request', param: 'questions' }) })
  );
  expect(makeImageGenerationProxyRequest).not.toHaveBeenCalled();
});

test('success: forwards client path as-is against the provider baseUrl (official /v1/systemone semantics)', async () => {
  mockPipelineSuccess();
  vi.mocked(makeImageGenerationProxyRequest).mockResolvedValue({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      model: 'jev-1.13.0',
      answers: { queue: { type: 'choice', choice: 'billing', confidence: 1 } },
      usage: { input_tokens: 451, output_tokens: 72 },
    },
  } as any);
  const handler = createDecisionsProxyHandler();
  const reply = createReply();
  const request = createRequest({
    model: 'Jev',
    state: 'My card was charged twice.',
    questions: { queue: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, technical: null } } },
  });

  await handler(request, reply);

  expect(makeImageGenerationProxyRequest).toHaveBeenCalledTimes(1);
  const [config, path, upstreamBody] = vi.mocked(makeImageGenerationProxyRequest).mock.calls[0];
  expect(config.baseUrl).toBe('https://api.typesafe.ai');
  expect(path).toBe('/v1/systemone');
  expect(upstreamBody.model).toBe('typesafe-ai/jev');
  expect(upstreamBody.state).toBe('My card was charged twice.');

  expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith('model-7');
  expect(reply.code).toHaveBeenCalledWith(200);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ answers: expect.objectContaining({ queue: expect.anything() }) })
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: 'typesafe',
      status: 'success',
      tokenCount: { promptTokens: 451, completionTokens: 72, totalTokens: 523 },
    })
  );
});

test('model_attributes.decisions_path overrides path for OpenRouter (endpoint outside /v1)', async () => {
  mockPipelineSuccess({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'typesafe/jev-1.13',
    modelAttributes: { decisions_path: 'alpha/decisions' },
  });
  vi.mocked(makeImageGenerationProxyRequest).mockResolvedValue({
    statusCode: 200,
    headers: {},
    body: { answers: {}, usage: { input_tokens: 1 } },
  } as any);
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ state: 's', questions: { q: { type: 'noul' } } }), reply);

  const [config, path, upstreamBody] = vi.mocked(makeImageGenerationProxyRequest).mock.calls[0];
  expect(config.baseUrl).toBe('https://openrouter.ai/api');
  expect(path).toBe('alpha/decisions');
  expect(upstreamBody.model).toBe('typesafe/jev-1.13');
});

test('upstream non-2xx passes through status/body and records a circuit failure', async () => {
  mockPipelineSuccess();
  vi.mocked(makeImageGenerationProxyRequest).mockResolvedValue({
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: { error: { code: 402, message: 'Insufficient credits' } },
  } as any);
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ state: 's', questions: { q: { type: 'noul' } } }), reply);

  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('model-7', expect.any(Error));
  expect(reply.code).toHaveBeenCalledWith(402);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ message: 'Insufficient credits' }) })
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
});

test('upstream network error returns a 500 error envelope', async () => {
  mockPipelineSuccess();
  vi.mocked(makeImageGenerationProxyRequest).mockRejectedValue(new Error('ECONNRESET'));
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ state: 's', questions: { q: { type: 'noul' } } }), reply);

  expect(reply.code).toHaveBeenCalledWith(500);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ code: 'proxy_error' }) })
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'error', errorMessage: 'ECONNRESET' })
  );
});

test('client abort cancels upstream and sends no response', async () => {
  mockPipelineSuccess();
  const abortError = new Error('The operation was aborted');
  abortError.name = 'AbortError';
  vi.mocked(makeImageGenerationProxyRequest).mockRejectedValue(abortError);
  const handler = createDecisionsProxyHandler();
  const reply = createReply();

  await handler(createRequest({ state: 's', questions: { q: { type: 'noul' } } }), reply);

  expect(reply.code).not.toHaveBeenCalled();
  expect(reply.send).not.toHaveBeenCalled();
});
