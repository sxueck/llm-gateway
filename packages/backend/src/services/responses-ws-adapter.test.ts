import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyReply } from 'fastify';
import { streamResponsesViaWebSocket } from './responses-ws-adapter.js';

function createMockReply() {
  const chunks: string[] = [];
  const reply: any = {
    raw: {
      headersSent: false,
      writableEnded: false,
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
  return reply as FastifyReply & { getChunks: () => string[]; raw: any };
}

describe('streamResponsesViaWebSocket', () => {
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

  it('should convert upstream WebSocket messages to SSE format', async () => {
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

    const reply = createMockReply();
    const result = await streamResponsesViaWebSocket(
      {
        provider: 'test',
        apiKey: 'test-key',
        baseUrl: `http://localhost:${serverPort}`,
        model: 'gpt-test',
      },
      { input: 'hi', model: 'gpt-test' },
      reply
    );

    const chunks = reply.getChunks();
    expect(chunks.some(c => c.includes('event: response.created'))).toBe(true);
    expect(chunks.some(c => c.includes('event: response.output_text.delta'))).toBe(true);
    expect(chunks.some(c => c.includes('event: response.completed'))).toBe(true);
    expect(chunks.some(c => c.includes('data: [DONE]'))).toBe(true);

    expect(result.totalTokens).toBe(15);
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
  });

  it('should strip instructions field from upstream events', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'r2', instructions: 'secret' },
        }));
        socket.close();
      });
    });

    const reply = createMockReply();
    await streamResponsesViaWebSocket(
      {
        provider: 'test',
        apiKey: 'test-key',
        baseUrl: `http://localhost:${serverPort}`,
        model: 'gpt-test',
      },
      { input: 'hi' },
      reply
    );

    const allData = reply.getChunks().join('');
    expect(allData.includes('"instructions":"secret"')).toBe(false);
  });

  it('should reject when provider has no baseUrl', async () => {
    const reply = createMockReply();
    await expect(
      streamResponsesViaWebSocket(
        { provider: 'test', apiKey: 'key', model: 'm' },
        {},
        reply
      )
    ).rejects.toThrow('base URL');
  });

  it('should terminate SSE on response.failed', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'response.failed',
          response: { id: 'r-fail', status: 'failed' },
        }));
        socket.close();
      });
    });

    const reply = createMockReply();
    const result = await streamResponsesViaWebSocket(
      { provider: 'test', apiKey: 'test-key', baseUrl: `http://localhost:${serverPort}`, model: 'gpt-test' },
      { input: 'hi' },
      reply
    );

    const chunks = reply.getChunks();
    expect(chunks.some(c => c.includes('event: response.failed'))).toBe(true);
    expect(chunks.some(c => c.includes('data: [DONE]'))).toBe(true);
    expect(reply.raw.writableEnded).toBe(true);
    expect(result.promptTokens).toBe(0);
  });

  it('should terminate SSE on response.incomplete', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'response.incomplete',
          response: { id: 'r-inc' },
        }));
        socket.close();
      });
    });

    const reply = createMockReply();
    const result = await streamResponsesViaWebSocket(
      { provider: 'test', apiKey: 'test-key', baseUrl: `http://localhost:${serverPort}`, model: 'gpt-test' },
      { input: 'hi' },
      reply
    );

    const chunks = reply.getChunks();
    expect(chunks.some(c => c.includes('event: response.incomplete'))).toBe(true);
    expect(chunks.some(c => c.includes('data: [DONE]'))).toBe(true);
    expect(reply.raw.writableEnded).toBe(true);
    expect(result.promptTokens).toBe(0);
  });

  it('should terminate SSE on response.cancelled', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'response.cancelled',
          response: { id: 'r-cancel' },
        }));
        socket.close();
      });
    });

    const reply = createMockReply();
    const result = await streamResponsesViaWebSocket(
      { provider: 'test', apiKey: 'test-key', baseUrl: `http://localhost:${serverPort}`, model: 'gpt-test' },
      { input: 'hi' },
      reply
    );

    const chunks = reply.getChunks();
    expect(chunks.some(c => c.includes('event: response.cancelled'))).toBe(true);
    expect(chunks.some(c => c.includes('data: [DONE]'))).toBe(true);
    expect(reply.raw.writableEnded).toBe(true);
    expect(result.promptTokens).toBe(0);
  });

  it('should reject when upstream closes before a terminal event', async () => {
    server.once('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'r-early-close' } }));
        socket.close();
      });
    });

    const reply = createMockReply();
    await expect(
      streamResponsesViaWebSocket(
        { provider: 'test', apiKey: 'test-key', baseUrl: `http://localhost:${serverPort}`, model: 'gpt-test' },
        { input: 'hi' },
        reply
      )
    ).rejects.toThrow('Upstream WebSocket closed before terminal event');

    expect(reply.raw.writableEnded).toBe(false);
  });
});
