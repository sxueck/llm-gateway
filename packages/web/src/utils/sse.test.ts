import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSEFrameParser, streamSSE, type SSEEvent } from './sse';

const authState = vi.hoisted(() => ({ token: 'pg-token' as string | null }));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authState }));
vi.mock('@/utils/request', () => ({ default: { get: vi.fn() } }));

import { streamPlayground } from '../api/playground';

function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

function okResponse(chunks: Array<string | Uint8Array>): Response {
  return { ok: true, status: 200, body: streamOf(chunks) } as unknown as Response;
}

function jsonResponse(status: number, json: () => Promise<unknown>): Response {
  return { ok: false, status, json } as unknown as Response;
}

async function collectEvents(token?: string, lastEventId?: string): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  await streamSSE('/api/events', { token, lastEventId, onEvent: (e) => events.push(e) });
  return events;
}

beforeEach(() => {
  authState.token = 'pg-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSEFrameParser', () => {
  it('parses LF-delimited frames', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('event: run\ndata: {"a":1}\n\ndata: b\n\n')).toEqual([
      { event: 'run', data: '{"a":1}' },
      { data: 'b' },
    ]);
  });

  it('parses CRLF frames without leaking CR into payloads', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('event: run\r\ndata: {"a":1}\r\n\r\n')).toEqual([
      { event: 'run', data: '{"a":1}' },
    ]);
  });

  it('never treats a single CRLF as a blank line (two data lines, one frame)', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('data: a\r\ndata: b\r\n\r\n')).toEqual([{ data: 'a\nb' }]);
  });

  it('treats a CRLF split across chunks as one atomic line break', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('data: a\r')).toEqual([]); // 悬置 CR 不判定
    expect(parser.push('\n\r')).toEqual([]); // data 行的 CRLF 完成，第二个 \r 仍悬置
    expect(parser.push('\n')).toEqual([{ data: 'a' }]); // 悬置 CR 判定为换行，构成空行
    expect(parser.push('data: b\n\n')).toEqual([{ data: 'b' }]);
  });

  it('handles mixed newline frame boundaries', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('data: a\n\r\ndata: b\r\n\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('treats a lone CR as a line break per the SSE spec', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('data: a\r\rdata: b\r\r\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('collects id/event fields, multiline data and skips comments', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('id: 1\nevent: log\ndata: line1\ndata: line2\n: keep-alive\n\ndata: second\n\n')).toEqual([
      { id: '1', event: 'log', data: 'line1\nline2' },
      { data: 'second' },
    ]);
  });

  it('holds back an incomplete trailing frame', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('data: partial')).toEqual([]);
    expect(parser.push('\n\n')).toEqual([{ data: 'partial' }]);
  });

  it('ignores empty and comment-only frames', () => {
    const parser = new SSEFrameParser();
    expect(parser.push('\n\n:ping\n\n\r\n\r\n')).toEqual([]);
  });
});

describe('streamSSE', () => {
  it('sends accept, authorization and last-event-id headers', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await collectEvents('jwt-1', '42');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/events');
    expect(init?.headers).toEqual({
      accept: 'text/event-stream',
      authorization: 'Bearer jwt-1',
      'last-event-id': '42',
    });
  });

  it('omits auth header when no token is given', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => okResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await collectEvents();
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('fails fast on a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => jsonResponse(503, async () => ({}))));
    await expect(collectEvents()).rejects.toThrow('SSE connect failed: HTTP 503');
  });

  it('fails fast when the response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => ({ ok: true, status: 200 } as unknown as Response)));
    await expect(collectEvents()).rejects.toThrow('SSE connect failed: HTTP 200');
  });

  it('reassembles a frame split across chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => okResponse(['event: run\ndata: {"seq', '":1}\n\n'])));
    expect(await collectEvents()).toEqual([{ event: 'run', data: '{"seq":1}' }]);
  });

  it('reassembles multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => okResponse([bytes.slice(0, 8), bytes.slice(8)])));
    expect(await collectEvents()).toEqual([{ data: '你好' }]);
  });

  it('propagates abort and passes the signal to fetch', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let captured: AbortSignal | null | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: a\n\n'));
        controller.signal.addEventListener('abort', () => c.error(controller.signal.reason));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      captured = init?.signal;
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }));

    const events: SSEEvent[] = [];
    const promise = streamSSE('/api/events', { signal: controller.signal, onEvent: (e) => events.push(e) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(captured).toBe(controller.signal);
    expect(events).toEqual([{ data: 'a' }]);
  });
});

describe('streamPlayground', () => {
  const payload = { virtualKeyId: 'vk1', model: 'gpt-4o', messages: [] };

  function runStream() {
    const onChunk = vi.fn();
    const onMetrics = vi.fn();
    const promise = streamPlayground('chat', payload, { onChunk, onMetrics });
    return { onChunk, onMetrics, promise };
  }

  it('POSTs with stream:true, event-stream accept and bearer token', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { promise } = runStream();
    await promise;

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/playground/chat');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer pg-token',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({ virtualKeyId: 'vk1', stream: true });
  });

  it('omits authorization when there is no token', async () => {
    authState.token = null;
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => okResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await runStream().promise;
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('delivers each data frame to onChunk exactly once (delta semantics)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      okResponse(['data: {"delta":"He"}\n\n', 'data: {"delta":"llo"}\n\ndata: {"delta":"!"}\n\n']),
    ));
    const { onChunk, onMetrics, promise } = runStream();
    await promise;

    expect(onChunk.mock.calls.map(([data]) => data)).toEqual([
      '{"delta":"He"}',
      '{"delta":"llo"}',
      '{"delta":"!"}',
    ]);
    expect(onMetrics).not.toHaveBeenCalled();
  });

  it('routes event: playground frames to onMetrics, not onChunk', async () => {
    const frame = {
      durationMs: 120,
      ttftMs: 50,
      cost: 0.001,
      metrics: { durationMs: 120, ttftMs: 50, usage: null, model: 'gpt-4o', requestId: 'r1' },
    };
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      okResponse([`event: playground\ndata: ${JSON.stringify(frame)}\n\n`, 'data: {"delta":"x"}\n\n']),
    ));
    const { onChunk, onMetrics, promise } = runStream();
    await promise;

    expect(onMetrics).toHaveBeenCalledWith(frame);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith('{"delta":"x"}');
  });

  it('ignores a corrupted metrics frame without failing the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      okResponse(['event: playground\ndata: not-json\n\n', 'data: {"delta":"x"}\n\n']),
    ));
    const { onChunk, onMetrics, promise } = runStream();
    await promise;

    expect(onMetrics).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledWith('{"delta":"x"}');
  });

  it('parses CRLF streams (used by OpenAI/Anthropic upstreams) identically', async () => {
    const frame = { durationMs: 9, ttftMs: 1, cost: 0, metrics: { durationMs: 9, ttftMs: 1, usage: null, model: 'm', requestId: null } };
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      okResponse([`event: playground\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`, 'data: {"delta":"y"}\r\n\r\n']),
    ));
    const { onChunk, onMetrics, promise } = runStream();
    await promise;

    expect(onMetrics).toHaveBeenCalledWith(frame);
    expect(onChunk).toHaveBeenCalledWith('{"delta":"y"}');
  });

  it('surfaces the upstream error message from the JSON envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => jsonResponse(400, async () => ({ error: { message: 'upstream boom' } }))));
    await expect(runStream().promise).rejects.toThrow('upstream boom');
  });

  it('falls back to the nested body.error.message', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => jsonResponse(401, async () => ({ body: { error: { message: 'nested' } } }))));
    await expect(runStream().promise).rejects.toThrow('nested');
  });

  it('falls back to the HTTP status for non-JSON error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      jsonResponse(502, async () => {
        throw new Error('not json');
      }),
    ));
    await expect(runStream().promise).rejects.toThrow('HTTP 502');
  });

  it('propagates abort mid-stream', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"delta":"x"}\n\n'));
        controller.signal.addEventListener('abort', () => c.error(controller.signal.reason));
      },
    });
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBe(controller.signal);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    const promise = streamPlayground('chat', payload, { signal: controller.signal, onChunk, onMetrics: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(onChunk).toHaveBeenCalledWith('{"delta":"x"}');
  });
});
