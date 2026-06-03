import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { bridgeResponsesWebSocket } from './ws-to-sse-bridge.js';
import { ProtocolAdapter } from './protocol-adapter.js';
import type { StreamTokenUsage } from '../routes/proxy/http-client.js';

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

function createMockAdapter(streamResponseFn: (_config: any, _input: any, _options: any, reply: any, _signal?: AbortSignal) => Promise<StreamTokenUsage>) {
  return {
    streamResponse: vi.fn(streamResponseFn),
  } as unknown as ProtocolAdapter;
}

describe('bridgeResponsesWebSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should forward SSE events as WebSocket frames', async () => {
    const mockWs = createMockSocket();
    const abortController = new AbortController();

    const adapter = createMockAdapter(async (_config, _input, _options, reply, _signal) => {
      reply.raw.write(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":{"text":"Hello"}}\n\n'
      );
      reply.raw.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
      reply.raw.end();

      return {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        streamChunks: [],
      };
    });

    const result = await bridgeResponsesWebSocket({
      config: { provider: 'test', apiKey: 'key', model: 'gpt-test' } as any,
      requestBody: { type: 'response.create', input: 'hi' },
      socket: mockWs as any,
      abortController,
      logPrefix: 'test',
      adapter,
    });

    const messages = mockWs.getSentMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('response.output_text.delta');
    expect(messages[0].delta.text).toBe('Hello');
    expect(messages[1].type).toBe('response.completed');
    expect(mockWs.close).toHaveBeenCalledWith(1000, 'stream_complete');
    expect(result.totalTokens).toBe(15);
  });

  it('should close socket on terminal event types', async () => {
    const mockWs = createMockSocket();
    const abortController = new AbortController();

    const adapter = createMockAdapter(async (_config, _input, _options, reply, _signal) => {
      reply.raw.write('event: response.failed\ndata: {"type":"response.failed","error":{"message":"failed"}}\n\n');
      reply.raw.end();

      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        streamChunks: [],
      };
    });

    await bridgeResponsesWebSocket({
      config: { provider: 'test', apiKey: 'key', model: 'gpt-test' } as any,
      requestBody: { type: 'response.create', input: 'hi' },
      socket: mockWs as any,
      abortController,
      logPrefix: 'test',
      adapter,
    });

    expect(mockWs.close).toHaveBeenCalledWith(1000, 'stream_complete');
    const messages = mockWs.getSentMessages();
    expect(messages[0].type).toBe('response.failed');
  });

  it('should send error event when upstream fails', async () => {
    const mockWs = createMockSocket();
    const abortController = new AbortController();

    const adapter = createMockAdapter(async () => {
      throw new Error('upstream connection refused');
    });

    await expect(
      bridgeResponsesWebSocket({
        config: { provider: 'test', apiKey: 'key', model: 'gpt-test' } as any,
        requestBody: { type: 'response.create', input: 'hi' },
        socket: mockWs as any,
        abortController,
        logPrefix: 'test',
        adapter,
      })
    ).rejects.toThrow('upstream connection refused');

    const messages = mockWs.getSentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('error');
    expect(messages[0].error.message).toBe('upstream connection refused');
    expect(mockWs.close).toHaveBeenCalledWith(1011, 'upstream_error');
  });

  it('should skip invalid JSON in SSE chunks', async () => {
    const mockWs = createMockSocket();
    const abortController = new AbortController();

    const adapter = createMockAdapter(async (_config, _input, _options, reply, _signal) => {
      reply.raw.write('event: response.output_text.delta\ndata: not-json\n\n');
      reply.raw.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
      reply.raw.end();

      return {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        streamChunks: [],
      };
    });

    const result = await bridgeResponsesWebSocket({
      config: { provider: 'test', apiKey: 'key', model: 'gpt-test' } as any,
      requestBody: { type: 'response.create', input: 'hi' },
      socket: mockWs as any,
      abortController,
      logPrefix: 'test',
      adapter,
    });

    const messages = mockWs.getSentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('response.completed');
    expect(result.totalTokens).toBe(2);
  });

  it('should abort upstream when max duration is reached', async () => {
    const mockWs = createMockSocket();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, 'abort');

    const adapter = createMockAdapter(async (_config, _input, _options, reply, signal) => {
      // Simulate a long-running stream
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reply.raw.end();
          resolve({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            streamChunks: [],
          });
        }, 5000);

        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          const abortError = new Error('Request aborted');
          (abortError as any).name = 'AbortError';
          reject(abortError);
        });
      });
    });

    const promise = bridgeResponsesWebSocket({
      config: { provider: 'test', apiKey: 'key', model: 'gpt-test' } as any,
      requestBody: { type: 'response.create', input: 'hi' },
      socket: mockWs as any,
      abortController,
      logPrefix: 'test',
      maxDurationMs: 50,
      adapter,
    });

    await expect(promise).rejects.toThrow();
    expect(abortSpy).toHaveBeenCalled();
    const messages = mockWs.getSentMessages();
    expect(messages[0].type).toBe('error');
    expect(messages[0].error.code).toBe('max_duration');
  });
});
