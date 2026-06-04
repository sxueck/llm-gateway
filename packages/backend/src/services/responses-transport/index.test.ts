import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import {
  isTerminalEvent,
  isTerminalEventType,
  buildErrorEvent,
  normalizeResponseCreate,
  parseClientWebSocketEvent,
  serverEventToSseFrame,
  serverEventToWsFrame,
  buildQueueError,
  parseSseEventLine,
} from './helpers.js';
import {
  ERROR_TYPES,
  WS_CLOSE_CODES,
} from './constants.js';
import { resolveTransportMode } from './mode-resolver.js';
import { writeEventsToSse } from './downstream-sse-writer.js';
import { writeEventsToWebSocket } from './downstream-ws-writer.js';
import { streamUpstreamWebSocket } from './upstream-ws-adapter.js';

describe('responses-transport contracts', () => {
  describe('isTerminalEventType', () => {
    it('returns true for terminal types', () => {
      expect(isTerminalEventType('response.completed')).toBe(true);
      expect(isTerminalEventType('response.failed')).toBe(true);
      expect(isTerminalEventType('response.incomplete')).toBe(true);
      expect(isTerminalEventType('response.cancelled')).toBe(true);
      expect(isTerminalEventType('error')).toBe(true);
      expect(isTerminalEventType('response.error')).toBe(true);
    });

    it('returns false for non-terminal types', () => {
      expect(isTerminalEventType('response.created')).toBe(false);
      expect(isTerminalEventType('response.output_text.delta')).toBe(false);
      expect(isTerminalEventType(undefined)).toBe(false);
    });
  });

  describe('isTerminalEvent', () => {
    it('returns true for terminal events', () => {
      expect(isTerminalEvent({ type: 'response.completed' } as any)).toBe(true);
    });
    it('returns false for non-terminal events', () => {
      expect(isTerminalEvent({ type: 'response.output_text.delta' } as any)).toBe(false);
    });
    it('returns false for undefined', () => {
      expect(isTerminalEvent(undefined)).toBe(false);
    });
  });

  describe('buildErrorEvent', () => {
    it('builds a standard error event', () => {
      const event = buildErrorEvent('something failed', 'test_code');
      expect(event.type).toBe('error');
      expect(event.error.message).toBe('something failed');
      expect(event.error.code).toBe('test_code');
      expect(event.error.type).toBe(ERROR_TYPES.GATEWAY_ERROR);
      expect(event.error.param).toBeNull();
    });
  });

  describe('normalizeResponseCreate', () => {
    it('flattens response.create wrapper', () => {
      const result = normalizeResponseCreate({
        type: 'response.create',
        response: { model: 'gpt-4', input: 'hi' },
      });
      expect(result.body.model).toBe('gpt-4');
      expect(result.body.input).toBe('hi');
      expect(result.body.type).toBeUndefined();
      expect(result.stream).toBe(true);
    });

    it('passes through plain body', () => {
      const result = normalizeResponseCreate({ model: 'gpt-4', input: 'hi' });
      expect(result.body.model).toBe('gpt-4');
      expect(result.stream).toBe(true);
    });

    it('extracts conversation/session ids', () => {
      const result = normalizeResponseCreate({
        conversationId: 'c1',
        sessionId: 's1',
        input: 'hi',
      });
      expect(result.conversationId).toBe('c1');
      expect(result.sessionId).toBe('s1');
    });
  });

  describe('parseClientWebSocketEvent', () => {
    it('parses response.create', () => {
      const event = parseClientWebSocketEvent(Buffer.from(JSON.stringify({ type: 'response.create' })), false);
      expect(event.type).toBe('response.create');
    });

    it('parses response.cancel', () => {
      const event = parseClientWebSocketEvent(JSON.stringify({ type: 'response.cancel' }), false);
      expect(event.type).toBe('response.cancel');
    });

    it('rejects binary frames', () => {
      try {
        parseClientWebSocketEvent(Buffer.from('x'), true);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('binary_not_supported');
      }
    });

    it('rejects invalid JSON', () => {
      try {
        parseClientWebSocketEvent('not-json', false);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('invalid_json');
      }
    });

    it('rejects unsupported event types', () => {
      try {
        parseClientWebSocketEvent(JSON.stringify({ type: 'unknown' }), false);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('unsupported_client_event');
      }
    });
  });

  describe('serverEventToSseFrame', () => {
    it('serialises an event to SSE', () => {
      const frame = serverEventToSseFrame({ type: 'response.output_text.delta', delta: { text: 'hi' } } as any);
      expect(frame).toContain('event: response.output_text.delta');
      expect(frame).toContain('data:');
      expect(frame).toContain('"hi"');
    });
  });

  describe('serverEventToWsFrame', () => {
    it('serialises an event to JSON', () => {
      const frame = serverEventToWsFrame({ type: 'response.completed' } as any);
      expect(JSON.parse(frame).type).toBe('response.completed');
    });
  });

  describe('buildQueueError', () => {
    it('builds queue_full error', () => {
      const err = buildQueueError('queue_full');
      expect(err.error.code).toBe('queue_queue_full');
      expect(err.error.type).toBe(ERROR_TYPES.RATE_LIMIT_ERROR);
    });
  });

  describe('parseSseEventLine', () => {
    it('parses a valid JSON line', () => {
      const event = parseSseEventLine('{"type":"response.completed"}');
      expect(event?.type).toBe('response.completed');
    });
    it('returns undefined for [DONE]', () => {
      expect(parseSseEventLine('[DONE]')).toBeUndefined();
    });
    it('returns undefined for invalid JSON', () => {
      expect(parseSseEventLine('not-json')).toBeUndefined();
    });
  });
});

describe('resolveTransportMode', () => {
  it('resolves ws_to_ws', () => {
    expect(resolveTransportMode(true, 'websocket')).toBe('ws_to_ws');
  });
  it('resolves ws_to_http_sse', () => {
    expect(resolveTransportMode(true, 'http_sse')).toBe('ws_to_http_sse');
  });
  it('resolves http_sse_to_ws', () => {
    expect(resolveTransportMode(false, 'websocket')).toBe('http_sse_to_ws');
  });
  it('resolves http_sse_to_http_sse', () => {
    expect(resolveTransportMode(false, 'http_sse')).toBe('http_sse_to_http_sse');
  });
});

describe('downstream-sse-writer', () => {
  function createMockReply() {
    const chunks: string[] = [];
    const reply: any = {
      raw: {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        writeHead: (status: number, headers: Record<string, string>) => {
          reply.raw.headersSent = true;
          reply.raw.statusCode = status;
          reply.raw.responseHeaders = headers;
        },
        write: (data: string) => {
          chunks.push(data);
          return true;
        },
        end: () => {
          reply.raw.writableEnded = true;
        },
      },
      getChunks: () => chunks,
    };
    return reply;
  }

  it('writes events as SSE frames and ends with [DONE]', async () => {
    const reply = createMockReply();
    async function* events() {
      yield { type: 'response.output_text.delta', delta: { text: 'Hello' } } as any;
      yield { type: 'response.completed' } as any;
      yield { type: '__stream_result', __result: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 }, terminalEventReceived: true, transportMode: 'http_sse_to_http_sse' } } as any;
    }

    const result = await writeEventsToSse(events(), { reply });

    const chunks = reply.getChunks();
    expect(chunks.some((c: string) => c.includes('event: response.output_text.delta'))).toBe(true);
    expect(chunks.some((c: string) => c.includes('event: response.completed'))).toBe(true);
    expect(chunks.some((c: string) => c.includes('data: [DONE]'))).toBe(true);
    expect(reply.raw.writableEnded).toBe(true);
    expect(result.transportMode).toBe('http_sse_to_http_sse');
    // Internal __stream_result sentinel must NOT leak to the client
    expect(chunks.some((c: string) => c.includes('__stream_result'))).toBe(false);
  });
});

describe('downstream-ws-writer', () => {
  function createMockSocket() {
    const sentMessages: any[] = [];
    const mockWs: any = {
      readyState: WebSocket.OPEN,
      send: vi.fn((data: string) => {
        sentMessages.push(JSON.parse(data));
      }),
      close: vi.fn(() => {
        mockWs.readyState = WebSocket.CLOSED;
      }),
      getSentMessages: () => sentMessages,
    };
    return mockWs;
  }

  it('sends events as JSON frames', async () => {
    const socket = createMockSocket();
    async function* events() {
      yield { type: 'response.output_text.delta', delta: { text: 'Hi' } } as any;
      yield { type: 'response.completed' } as any;
      yield { type: '__stream_result', __result: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedTokens: 0 }, terminalEventReceived: true, transportMode: 'ws_to_http_sse' } } as any;
    }

    const result = await writeEventsToWebSocket(events(), { socket, closeOnTerminal: false });

    const messages = socket.getSentMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('response.output_text.delta');
    expect(messages[1].type).toBe('response.completed');
    expect(socket.close).not.toHaveBeenCalled();
    expect(result.terminalEventReceived).toBe(true);
    expect(result.tokenUsage.totalTokens).toBe(2);
  });

  it('closes on terminal when closeOnTerminal is true', async () => {
    const socket = createMockSocket();
    async function* events() {
      yield { type: 'response.completed' } as any;
      yield { type: '__stream_result', __result: { tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }, terminalEventReceived: true, transportMode: 'ws_to_http_sse' } } as any;
    }

    const result = await writeEventsToWebSocket(events(), { socket, closeOnTerminal: true });
    expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_CODES.NORMAL, 'stream_complete');
    expect(result.terminalEventReceived).toBe(true);
  });
});

describe('upstream-ws-adapter', () => {
  let server: WebSocketServer;
  let serverPort: number;

  beforeAll(() => {
    return new Promise<void>((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('yields upstream events and returns usage metadata', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        expect(msg.type).toBe('response.create');
        expect(msg.model).toBe('gpt-test');

        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: { text: 'Hello' } }));
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'r1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        }));
        socket.close();
      });
    });

    const abortController = new AbortController();
    const generator = streamUpstreamWebSocket(
      { provider: 'test', apiKey: 'test-key', baseUrl: `http://localhost:${serverPort}`, model: 'gpt-test' },
      { body: { input: 'hi' } },
      abortController.signal
    );

    const events: any[] = [];
    let result: any;
    try {
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        events.push(next.value);
      }
    } finally {
      await generator.return?.({
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
        terminalEventReceived: false,
        transportMode: 'ws_to_ws',
      });
    }

    expect(events.some(e => e.type === 'response.created')).toBe(true);
    expect(events.some(e => e.type === 'response.output_text.delta')).toBe(true);
    expect(events.some(e => e.type === 'response.completed')).toBe(true);
    expect(result.tokenUsage.totalTokens).toBe(15);
    expect(result.terminalEventReceived).toBe(true);
  });

  it('stops yielding after abort', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'response.created' }));
        // intentionally delay next message so abort can fire
      });
    });

    const abortController = new AbortController();
    const generator = streamUpstreamWebSocket(
      { provider: 'test', apiKey: 'key', baseUrl: `http://localhost:${serverPort}`, model: 'm' },
      { body: { input: 'hi' } },
      abortController.signal
    );

    const events: any[] = [];
    let done = false;

    // Start consuming
    const consumePromise = (async () => {
      try {
        for await (const event of generator) {
          events.push(event);
        }
      } catch {
        // expected on abort
      }
      done = true;
    })();

    // Abort shortly after
    setTimeout(() => abortController.abort(), 50);
    await consumePromise;

    expect(done).toBe(true);
  });
});
