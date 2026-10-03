import Fastify from 'fastify';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  estimateUsageCost: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  virtualKeyDb: { getById: mocks.getById },
}));
vi.mock('../services/cost-mapping.js', () => ({
  costMappingService: { estimateUsageCost: mocks.estimateUsageCost },
}));

import { playgroundRoutes } from './playground.js';
import type { VirtualKey } from '../types/index.js';

/** 与实现 loopbackBase() 相同的推导方式（PORT 未设时 3000）。 */
function loopbackBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function makeVirtualKey(overrides: Partial<VirtualKey> = {}): VirtualKey {
  return {
    id: 'vk_1',
    key_value: 'sk-playground-secret',
    key_hash: 'hash',
    name: 'playground key',
    provider_id: null,
    model_id: null,
    routing_strategy: 'single',
    model_ids: null,
    routing_config: null,
    enabled: 1,
    rate_limit: null,
    cache_enabled: 1,
    disable_logging: 0,
    dynamic_compression_enabled: 0,
    image_compression_enabled: 0,
    intercept_zero_temperature: 0,
    zero_temperature_replacement: null,
    pii_protection_enabled: 0,
    prompt_capture_enabled: 1,
    context_normalization_enabled: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function buildApp() {
  const app = Fastify();
  app.decorate('authenticate', async () => {});
  await playgroundRoutes(app);
  return app;
}

const chatPayload = {
  virtualKeyId: 'vk_1',
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('playground validation errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getById.mockResolvedValue(makeVirtualKey());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['missing virtualKeyId', { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] }],
    ['messages not an array', { virtualKeyId: 'vk_1', model: 'gpt-test', messages: 'nope' }],
    ['missing model', { virtualKeyId: 'vk_1', messages: [{ role: 'user', content: 'hi' }] }],
  ])('returns a 400 OpenAI error envelope when %s', async (_name, payload) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toMatchObject({
        message: expect.any(String),
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_playground_request',
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the virtual key does not exist', async () => {
    mocks.getById.mockResolvedValue(undefined);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: chatPayload,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('virtual_key_not_found');
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 403 when the virtual key is disabled (enabled !== 1)', async () => {
    mocks.getById.mockResolvedValue(makeVirtualKey({ enabled: 0 }));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: chatPayload,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('virtual_key_disabled');
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('playground /playground/chat non-stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getById.mockResolvedValue(makeVirtualKey());
    mocks.estimateUsageCost.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const upstreamBody = {
    id: 'chatcmpl-1',
    model: 'gpt-test',
    choices: [{ message: { role: 'assistant', content: 'hello' } }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  };

  it('proxies to loopback /v1/chat/completions with the key and playground UA', async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(upstreamBody, 200, { 'x-request-id': 'req_abc' }),
    );
    mocks.estimateUsageCost.mockResolvedValue(0.123);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: chatPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        ok: true,
        status: 200,
        protocol: 'openai',
        durationMs: expect.any(Number),
        ttftMs: null,
        cost: 0.123,
      });
      expect(body.metrics).toEqual({
        durationMs: expect.any(Number),
        ttftMs: null,
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          cachedTokens: 3,
          totalTokens: 18,
        },
        model: 'gpt-test',
        requestId: 'req_abc',
      });
      expect(body.body).toEqual(upstreamBody);

      expect(mocks.estimateUsageCost).toHaveBeenCalledWith('gpt-test', {
        promptTokens: 11,
        completionTokens: 7,
        cachedTokens: 3,
        totalTokens: 18,
      });

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = mocks.fetch.mock.calls[0];
      expect(url).toBe(`${loopbackBase()}/v1/chat/completions`);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-playground-secret');
      expect(headers['user-agent']).toBe('llm-gateway-playground');
      expect(headers['anthropic-version']).toBeUndefined();
      const sentBody = JSON.parse(init.body);
      expect(sentBody).toMatchObject({ model: 'gpt-test', stream: false });
      expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    } finally {
      await app.close();
    }
  });

  it('propagates cost === null when the model has no price', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(upstreamBody));
    mocks.estimateUsageCost.mockResolvedValue(null);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: chatPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(body.cost).toBe(null);
    } finally {
      await app.close();
    }
  });

  it('passes the upstream 4xx status and error envelope through (not 200)', async () => {
    const upstreamError = {
      error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: '429' },
    };
    mocks.fetch.mockResolvedValue(jsonResponse(upstreamError, 429));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: chatPayload,
      });

      expect(response.statusCode).toBe(429);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe(429);
      expect(body.cost).toBe(null);
      expect(body.body).toEqual(upstreamError);
    } finally {
      await app.close();
    }
  });

  it('streams upstream bytes through and appends a playground metrics frame', async () => {
    const sse = [
      'data: {"id":"c1","model":"gpt-test","choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"id":"c1","model":"gpt-test","choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    mocks.fetch.mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    mocks.estimateUsageCost.mockResolvedValue(0.42);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/chat',
        payload: { ...chatPayload, stream: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      // 原样透传：上游两帧 delta 必须出现在响应体里
      expect(response.body).toContain('"delta":{"content":"he"}');
      expect(response.body).toContain('"delta":{"content":"llo"}');

      const marker = 'event: playground\ndata: ';
      expect(response.body).toContain(marker);
      const frameJson = response.body.split(marker)[1].split('\n\n')[0];
      const frame = JSON.parse(frameJson);
      expect(frame.durationMs).toEqual(expect.any(Number));
      expect(frame.cost).toBe(0.42);
      expect(frame.metrics.model).toBe('gpt-test');
      expect(frame.metrics.usage).toEqual({
        promptTokens: 11,
        completionTokens: 7,
        cachedTokens: 3,
        totalTokens: 18,
      });
      // 流式请求带 AbortSignal（客户端断连中止上游）
      const init = mocks.fetch.mock.calls[0][1];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await app.close();
    }
  });
});

describe('playground /playground/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getById.mockResolvedValue(makeVirtualKey());
    mocks.estimateUsageCost.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxies to loopback /v1/messages with anthropic headers and Anthropic usage accounting', async () => {
    const upstreamBody = {
      id: 'msg_1',
      model: 'claude-test',
      content: [{ type: 'text', text: 'hello' }],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 8,
      },
    };
    mocks.fetch.mockResolvedValue(jsonResponse(upstreamBody));
    mocks.estimateUsageCost.mockResolvedValue(0.5);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/playground/messages',
        payload: {
          virtualKeyId: 'vk_1',
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.protocol).toBe('anthropic');
      expect(body.cost).toBe(0.5);
      expect(body.body).toEqual(upstreamBody);
      // Anthropic 口径：prompt = input + cache_read + cache_creation，
      // cachedTokens 只计 cache_read，cache_creation 不计入。
      expect(body.metrics.usage).toEqual({
        promptTokens: 24,
        completionTokens: 4,
        cachedTokens: 6,
        totalTokens: 28,
      });

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = mocks.fetch.mock.calls[0];
      expect(url).toBe(`${loopbackBase()}/v1/messages`);
      const headers = init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-playground-secret');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['user-agent']).toBe('llm-gateway-playground');
      const sentBody = JSON.parse(init.body);
      expect(sentBody).toMatchObject({
        model: 'claude-test',
        max_tokens: 1024,
        stream: false,
      });
    } finally {
      await app.close();
    }
  });
});

describe('playground GET /playground/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.getById.mockResolvedValue(makeVirtualKey());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the upstream model list keyed by virtualKeyId', async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ data: [{ id: 'm1' }] }));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/playground/models?virtualKeyId=vk_1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ virtualKeyId: 'vk_1', models: [{ id: 'm1' }] });
      const [url, init] = mocks.fetch.mock.calls[0];
      expect(url).toBe(`${loopbackBase()}/v1/models`);
      const headers = init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-playground-secret');
      expect(headers['user-agent']).toBe('llm-gateway-playground');
    } finally {
      await app.close();
    }
  });

  it('returns 200 with empty models and an error string for an unknown key', async () => {
    mocks.getById.mockResolvedValue(undefined);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/playground/models?virtualKeyId=missing',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        virtualKeyId: 'missing',
        models: [],
        error: 'virtual key not found',
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 200 with empty models and an error string when upstream fetch throws', async () => {
    mocks.fetch.mockRejectedValue(new Error('connection refused'));
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/playground/models?virtualKeyId=vk_1',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toEqual([]);
      expect(typeof body.error).toBe('string');
      expect(body.error).toContain('connection refused');
    } finally {
      await app.close();
    }
  });

  it('returns 200 with the upstream error message when upstream responds non-2xx', async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse({ error: { message: 'quota exhausted' } }, 402),
    );
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/playground/models?virtualKeyId=vk_1',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        virtualKeyId: 'vk_1',
        models: [],
        error: 'quota exhausted',
      });
    } finally {
      await app.close();
    }
  });
});
