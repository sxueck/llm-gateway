import { beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import Fastify from 'fastify';

import { createOpenAIProxyHandler } from './proxy-handler.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { makeStreamHttpRequest } from '../proxy/http-client.js';
import { resetBudgetStates } from '../../services/context-budget.js';

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

// 预算门在 pipeline（鉴权/路由）之后、dispatch 之前：直接注入解析完成的
// 上下文，聚焦门本身的判定，不引入模型解析/上游依赖。
vi.mock('../proxy/pipeline.js', () => ({
  runProxyPipeline: vi.fn(),
}));

vi.mock('../../services/context-normalization/index.js', () => ({
  applyContextNormalization: vi.fn(async () => ({ blocked: false })),
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

const KEY_VALUE = 'sk-responses-budget-test-key';

function makeVirtualKey(contextBudgetTokens: number) {
  return {
    id: 'vk-responses-budget',
    key_value: KEY_VALUE,
    enabled: 1,
    cache_enabled: 0,
    context_budget_tokens: contextBudgetTokens,
    pii_protection_enabled: 0,
  };
}

function mockPipelineResolved(path: string, virtualKey: any) {
  vi.mocked(runProxyPipeline).mockResolvedValue({
    ok: true,
    context: {
      requestIp: '127.0.0.1',
      requestUserAgent: 'vitest',
      virtualKey,
      virtualKeyValue: KEY_VALUE,
      provider: { name: 'TestProvider' },
      providerId: 'provider-1',
      currentModel: {
        id: 7,
        name: 'Test Model',
        model_identifier: 'test-model',
      },
      modelResult: { circuitBreakerKey: 'cb-key', canRetry: false },
      configResult: {
        protocolConfig: {
          provider: 'test',
          apiKey: 'sk-upstream',
          baseUrl: 'https://upstream.test',
          model: 'test-model',
          protocol: 'openai',
        },
        path,
        vkDisplay: 'sk-res...-key',
        isStreamRequest: true,
      },
    },
  } as any);
}

/** 边界形态（新用户输入收尾）+ 超预算的工具回包载荷。 */
function overBudgetBoundaryInput() {
  return [
    {
      role: 'developer',
      content: [{ type: 'input_text', text: 'You are a coding agent harness.' }],
    },
    { role: 'user', content: [{ type: 'input_text', text: 'read the document' }] },
    {
      type: 'function_call',
      call_id: 'c1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'docs/big.md' }),
    },
    {
      type: 'function_call_output',
      call_id: 'c1',
      output: 'x'.repeat(120_000),
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done reading' }],
    },
    { role: 'user', content: [{ type: 'input_text', text: 'what is the key takeaway' }] },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBudgetStates();
  vi.mocked(makeStreamHttpRequest).mockImplementation(
    (async (_protocolConfig: any, _messages: any, _options: any, reply: any) => {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.raw.end('data: [DONE]\n\n');
      return {
        totalTokens: 10,
        promptTokens: 4,
        completionTokens: 6,
        streamChunks: ['data: [DONE]\n\n'],
        tffbMs: 3,
      };
    }) as any,
  );
});

test('over-budget boundary /v1/responses request is blocked with 400 before dispatch', async () => {
  mockPipelineResolved('/v1/responses', makeVirtualKey(5_000));

  const app = Fastify();
  app.post('/v1/responses', createOpenAIProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: 'test-model',
      stream: true,
      instructions: 'You are a coding agent harness.',
      input: overBudgetBoundaryInput(),
    },
  });
  await app.close();

  expect(res.statusCode).toBe(400);
  const error = res.json().error;
  expect(error.code).toBe('context_length_exceeded');
  expect(error.type).toBe('invalid_request_error');
  expect(error.param).toBe('input');
  expect(error.message).toMatch(
    /maximum context length is 5000 tokens\. However, your messages resulted in \d+ tokens\./,
  );
  expect(res.headers['x-should-retry']).toBe('false');
  expect(res.headers['x-gateway-budget']).toBe('enforced');
  // 拦截必须发生在任何上游调用之前（不产生上游费用）。
  expect(makeStreamHttpRequest).not.toHaveBeenCalled();
});

test('over-budget tool continuation passes the gate and dispatches upstream', async () => {
  mockPipelineResolved('/v1/responses', makeVirtualKey(5_000));

  const app = Fastify();
  app.post('/v1/responses', createOpenAIProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: 'test-model',
      stream: true,
      input: [
        { role: 'user', content: 'run tests' },
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'bash',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'x'.repeat(120_000),
        },
      ],
    },
  });
  await app.close();

  expect(res.statusCode).toBe(200);
  expect(makeStreamHttpRequest).toHaveBeenCalledTimes(1);
});

test('compaction request via instructions and /v1/responses/compact are exempt', async () => {
  mockPipelineResolved('/v1/responses', makeVirtualKey(5_000));

  const app = Fastify();
  app.post('/v1/responses', createOpenAIProxyHandler());
  app.post('/v1/responses/compact', createOpenAIProxyHandler());

  // 签名命中的压缩请求：结构上是边界且超预算，仍必须豁免放行。
  const compactViaSignature = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: 'test-model',
      stream: true,
      instructions: 'You are a context summarization assistant.',
      input: overBudgetBoundaryInput(),
    },
  });
  expect(compactViaSignature.statusCode).toBe(200);

  // /v1/responses/compact 入口：不判预算，直接放行到 dispatch。
  mockPipelineResolved('/v1/responses/compact', makeVirtualKey(5_000));
  const compactEndpoint = await app.inject({
    method: 'POST',
    url: '/v1/responses/compact',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: 'test-model',
      stream: true,
      input: overBudgetBoundaryInput(),
    },
  });
  await app.close();

  expect(compactEndpoint.statusCode).toBe(200);
  expect(makeStreamHttpRequest).toHaveBeenCalledTimes(2);
});

test('previous_response_id history lives upstream: passed, not blocked', async () => {
  mockPipelineResolved('/v1/responses', makeVirtualKey(5_000));

  const app = Fastify();
  app.post('/v1/responses', createOpenAIProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: 'test-model',
      stream: true,
      previous_response_id: 'resp_upstream_history',
      input: overBudgetBoundaryInput(),
    },
  });
  await app.close();

  // 上游会话状态不可核对：按 unknown 放行，只告警。
  expect(res.statusCode).toBe(200);
  expect(makeStreamHttpRequest).toHaveBeenCalledTimes(1);
});
