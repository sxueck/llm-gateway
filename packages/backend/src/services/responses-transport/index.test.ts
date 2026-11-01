import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import {
  WS_CLOSE_CODES,
} from './constants.js';
import { resolveTransportMode } from './mode-resolver.js';
import { writeEventsToSse } from './downstream-sse-writer.js';
import { writeEventsToWebSocket } from './downstream-ws-writer.js';
import { streamUpstreamWebSocket } from './upstream-ws-adapter.js';

describe('resolveTransportMode', () => {
  const modeCases: Array<[boolean, string, string]> = [
    [true, 'websocket', 'ws_to_ws'],
    [true, 'http_sse', 'ws_to_http_sse'],
    [false, 'websocket', 'http_sse_to_ws'],
    [false, 'http_sse', 'http_sse_to_http_sse'],
  ];
  it('resolves each transport mode combination', () => {
    for (const [isWs, clientMode, expected] of modeCases) {
      expect(resolveTransportMode(isWs, clientMode as any)).toBe(expected);
    }
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

  it('throws when upstream closes before a terminal event', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
        socket.close();
      });
    });

    const generator = streamUpstreamWebSocket(
      { provider: 'test', apiKey: 'key', baseUrl: `http://localhost:${serverPort}`, model: 'm' },
      { body: { input: 'hi' } },
      new AbortController().signal
    );

    await expect(
      (async () => {
        while (true) {
          const next = await generator.next();
          if (next.done) break;
        }
      })()
    ).rejects.toThrow('Upstream WebSocket closed before terminal event');
  });
});
