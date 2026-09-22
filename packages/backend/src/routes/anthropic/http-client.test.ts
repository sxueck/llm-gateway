import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= 'vitest-placeholder';
  process.env.JWT_SECRET ??= 'vitest-placeholder-secret-32-chars!!';
});

vi.mock('../../services/logger.js', () => ({
  memoryLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../utils/upstream-fetch.js', () => ({
  upstreamFetch: vi.fn(),
}));

import { makeAnthropicRequest, makeAnthropicStreamRequest } from './http-client.js';
import { upstreamFetch } from '../../utils/upstream-fetch.js';
import { EmptyOutputError } from '../../errors/empty-output-error.js';

const fetchMock = vi.mocked(upstreamFetch);

const CONFIG = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-5',
  protocol: 'anthropic',
  modelAttributes: { headers: { 'X-Custom': 'custom-value' } },
};

const REQUEST_BODY = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
} as any;

function textResponse(status: number, body: string, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  } as any;
}

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= frames.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(frames[index++]) };
        },
      }),
    },
  } as any;
}

function createReply() {
  const raw: any = {
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn(() => {
      raw.headersSent = true;
    }),
    write: vi.fn(),
    end: vi.fn(() => {
      raw.writableEnded = true;
    }),
  };
  return { raw } as any;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('makeAnthropicRequest', () => {
  test('sends raw POST to /v1/messages with auth, version, custom and beta headers', async () => {
    fetchMock.mockResolvedValue(textResponse(200, JSON.stringify({ id: 'msg_1', content: [] })));

    const result = await makeAnthropicRequest(
      CONFIG,
      { ...REQUEST_BODY, betas: ['context-1m-2025-08-07'] } as any,
      { 'x-forwarded-for': '1.2.3.4' }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['X-Custom']).toBe('custom-value');
    expect(init.headers['anthropic-beta']).toBe('context-1m-2025-08-07');
    expect(init.timeoutMs).toBeGreaterThan(0);
    expect(JSON.parse(init.body).model).toBe('claude-sonnet-4-5');

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).id).toBe('msg_1');
  });

  test('strips trailing /v1 from provider baseUrl before appending /v1/messages', async () => {
    fetchMock.mockResolvedValue(textResponse(200, '{}'));
    await makeAnthropicRequest({ ...CONFIG, baseUrl: 'https://compat.example/v1/' }, REQUEST_BODY);
    expect(fetchMock.mock.calls[0][0]).toBe('https://compat.example/v1/messages');
  });

  test('upstream error envelope passes through with upstream status and type', async () => {
    fetchMock.mockResolvedValue(
      textResponse(429, JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Too busy' } }))
    );

    const result = await makeAnthropicRequest(CONFIG, REQUEST_BODY);

    expect(result.statusCode).toBe(429);
    const parsed = JSON.parse(result.body);
    expect(parsed.error.type).toBe('rate_limit_error');
    expect(parsed.error.message).toBe('Too busy');
  });

  test('non-JSON upstream error body falls back to status-based normalization', async () => {
    fetchMock.mockResolvedValue(textResponse(503, '<html>gateway error</html>', 'text/html'));

    const result = await makeAnthropicRequest(CONFIG, REQUEST_BODY);

    expect(result.statusCode).toBe(503);
    const parsed = JSON.parse(result.body);
    expect(parsed.error.type).toBe('api_error');
    expect(parsed.error.message).toContain('503');
  });
});

describe('makeAnthropicStreamRequest', () => {
  test('parses SSE frames (incl. CRLF and comments), emits events, and reports usage', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        ': keep-alive\n\n',
        'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":7}}}\r\n\r\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
    );
    const reply = createReply();

    const usage = await makeAnthropicStreamRequest(CONFIG, REQUEST_BODY, reply);

    expect(usage.promptTokens).toBe(18); // 11 input + 7 cache read
    expect(usage.completionTokens).toBe(5);
    expect(usage.totalTokens).toBe(23);

    const written = reply.raw.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(written).toContain('event: message_start');
    expect(written).toContain('"text":"Hello"');
    expect(written).toContain('event: message_stop');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  test('upstream non-2xx enriches the thrown error with status and envelope', async () => {
    fetchMock.mockResolvedValue(
      textResponse(500, JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }))
    );
    const reply = createReply();

    await expect(makeAnthropicStreamRequest(CONFIG, REQUEST_BODY, reply)).rejects.toMatchObject({
      statusCode: 500,
      errorResponse: {
        error: { type: 'api_error', message: 'upstream exploded' },
      },
    });
    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  test('empty-output retry: second attempt succeeds and only one usage is returned', async () => {
    const emptyStream = sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const goodStream = sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    fetchMock.mockResolvedValueOnce(emptyStream).mockResolvedValueOnce(goodStream);
    const reply = createReply();

    const usage = await makeAnthropicStreamRequest(CONFIG, REQUEST_BODY, reply);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage.completionTokens).toBe(0);
    expect(usage.promptTokens).toBe(3);
    const written = reply.raw.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(written).toContain('"text":"ok"');
  });

  test('empty-output terminal state throws EmptyOutputError after exhausting retries', async () => {
    const config = {
      ...CONFIG,
      modelAttributes: { anthropic_empty_retry_limit: 0 },
    };
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
    );
    const reply = createReply();

    await expect(makeAnthropicStreamRequest(config, REQUEST_BODY, reply)).rejects.toBeInstanceOf(EmptyOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('forwards the provided abort signal to the upstream fetch', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ])
    );
    const reply = createReply();
    const controller = new AbortController();

    const usage = await makeAnthropicStreamRequest(CONFIG, REQUEST_BODY, reply, undefined, null, controller.signal);

    expect(usage.promptTokens).toBe(1);
    expect((fetchMock.mock.calls[0] as any[])[1].signal).toBe(controller.signal);
  });
});
