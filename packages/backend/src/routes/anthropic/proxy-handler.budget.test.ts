import { beforeEach, expect, test, vi } from 'vitest';

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

import Fastify from 'fastify';

import { createAnthropicProxyHandler } from './proxy-handler.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { makeAnthropicRequest, makeAnthropicStreamRequest } from './http-client.js';
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

vi.mock('./http-client.js', () => ({
  makeAnthropicRequest: vi.fn(),
  makeAnthropicStreamRequest: vi.fn(),
}));

vi.mock('../../services/api-request-logger.js', () => ({
  logApiRequestAsync: vi.fn(),
}));

vi.mock('../../services/pii-protection-service.js', () => ({
  maskRequestBodyInPlace: vi.fn(() => ({ applied: false, context: null, maskedCount: 0 })),
  restoreResponseBodyInPlace: vi.fn(),
}));

vi.mock('../../services/request-header-forwarding.js', () => ({
  requestHeaderForwardingService: { buildForwardedHeaders: vi.fn(() => ({})) },
}));

const KEY_VALUE = 'sk-ant-budget-test-key-0001';

function makeVirtualKey(contextBudgetTokens: number | null) {
  return {
    id: 'vk-anthropic-budget',
    key_value: KEY_VALUE,
    enabled: 1,
    cache_enabled: 0,
    context_budget_tokens: contextBudgetTokens,
    pii_protection_enabled: 0,
  } as any;
}

function mockPipelineResolved(virtualKey: any) {
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
        id: 3,
        name: 'Test Claude',
        model_identifier: 'test-claude',
        model_attributes: JSON.stringify({ context_window: 200_000 }),
      },
      modelResult: { circuitBreakerKey: 'cb-key', canRetry: false },
      configResult: {
        protocolConfig: {
          provider: 'anthropic',
          apiKey: 'sk-upstream',
          baseUrl: 'https://upstream.test',
          model: 'test-claude',
          protocol: 'anthropic',
        },
        path: '/v1/messages',
        vkDisplay: 'sk-ant...0001',
        isStreamRequest: true,
      },
    },
  } as any);
}

const sentence = 'The quick brown fox jumps over the lazy dog. ';

/**
 * 边界形态（新用户输入收尾）+ 只有 Anthropic 才有的载荷：
 * 回放的 thinking 文本、未闭合前的 tool_use/tool_result、顶层 system blocks。
 */
function overBudgetBoundaryMessages() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'read the document' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: sentence.repeat(4_000), signature: 'sig-1' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'cat docs/big.md' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done reading' }] },
    { role: 'user', content: [{ type: 'text', text: 'what is the key takeaway' }] },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBudgetStates();
});

async function postMessages(payload: any) {
  const app = Fastify();
  app.post('/v1/messages', createAnthropicProxyHandler());
  const res = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-api-key': KEY_VALUE, 'anthropic-version': '2023-06-01' },
    payload,
  });
  await app.close();
  return res;
}

test('over-budget boundary /v1/messages request is blocked with the Anthropic envelope before dispatch', async () => {
  mockPipelineResolved(makeVirtualKey(5_000));

  const res = await postMessages({
    model: 'test-claude',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent harness.' }],
    messages: overBudgetBoundaryMessages(),
  });

  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.type).toBe('error');
  expect(body.error.type).toBe('invalid_request_error');
  // 客户端（pi）按 /prompt (?:is )?too long/i 判定上下文溢出并自动压缩重试。
  expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 5000 maximum$/);
  expect(res.headers['x-should-retry']).toBe('false');
  expect(res.headers['x-gateway-budget']).toBe('enforced');
  // 拦截必须发生在任何上游调用之前（不产生上游费用）。
  expect(makeAnthropicStreamRequest).not.toHaveBeenCalled();
  expect(makeAnthropicRequest).not.toHaveBeenCalled();
});

test('same payload under a tier that fits is not blocked', async () => {
  // 方向性回归：thinking 入账后预算仍需真实超量才拦，不能变成一律 400。
  mockPipelineResolved(makeVirtualKey(400_000));

  const res = await postMessages({
    model: 'test-claude',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent harness.' }],
    messages: overBudgetBoundaryMessages(),
  });

  expect(res.statusCode).not.toBe(400);
  expect(res.headers['x-gateway-budget']).toBeUndefined();
  expect(makeAnthropicStreamRequest).toHaveBeenCalledTimes(1);
});

test('no budget tier on the virtual key leaves the gate untouched', async () => {
  mockPipelineResolved(makeVirtualKey(null));

  const res = await postMessages({
    model: 'test-claude',
    max_tokens: 1024,
    stream: true,
    messages: overBudgetBoundaryMessages(),
  });

  expect(res.headers['x-gateway-budget']).toBeUndefined();
  expect(res.statusCode).not.toBe(400);
  // 同形超量载荷，未配档位 → 门不得拦截。
  expect(makeAnthropicStreamRequest).toHaveBeenCalledTimes(1);
});
