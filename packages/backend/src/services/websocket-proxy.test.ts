import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { deriveWebSocketUrl, activeConnectionTracker, relayWebSocket } from './websocket-proxy.js';

describe('deriveWebSocketUrl', () => {
  it('should convert https:// to wss://', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should convert http:// to ws://', () => {
    expect(deriveWebSocketUrl('http://localhost:3000/v1', '/responses'))
      .toBe('ws://localhost:3000/v1/responses');
  });

  it('should preserve existing wss://', () => {
    expect(deriveWebSocketUrl('wss://api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should default to wss:// when no protocol is given', () => {
    expect(deriveWebSocketUrl('api.openai.com/v1', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should trim trailing slashes from base URL', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1///', '/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should handle path without leading slash', () => {
    expect(deriveWebSocketUrl('https://api.openai.com/v1', 'responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });

  it('should handle v1/responses path', () => {
    expect(deriveWebSocketUrl('https://api.openai.com', '/v1/responses'))
      .toBe('wss://api.openai.com/v1/responses');
  });
});

describe('activeConnectionTracker', () => {
  it('should start with zero connections', () => {
    expect(activeConnectionTracker.count).toBe(0);
  });

  it('should wait for close events during shutdown', async () => {
    let closeAllResolved = false;
    let closeCalled = false;
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      close() {
        closeCalled = true;
        setTimeout(() => {
          socket.readyState = WebSocket.CLOSED;
          socket.emit('close');
        }, 50);
      },
    }) as EventEmitter & { readyState: number; close: () => void };

    activeConnectionTracker.add(socket as unknown as WebSocket);

    const closeAllPromise = activeConnectionTracker.closeAll().then(() => {
      closeAllResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(closeCalled).toBe(true);
    expect(closeAllResolved).toBe(false);

    await closeAllPromise;

    expect(closeAllResolved).toBe(true);
    expect(activeConnectionTracker.count).toBe(0);
  });

  it('should report token usage from upstream messages', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));

    const address = server.address() as AddressInfo;
    server.on('connection', (upstream) => {
      setTimeout(() => {
        upstream.send(JSON.stringify({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              total_tokens: 16,
            },
          },
        }));
        upstream.close(1000, 'done');
      }, 20);
    });

    const downstream = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send() {},
      close(code?: number, reason?: string) {
        downstream.readyState = WebSocket.CLOSED;
        downstream.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
      },
    }) as EventEmitter & { readyState: number; send: () => void; close: (code?: number, reason?: string) => void };

    try {
      const tokenUsage = await new Promise<any>((resolve, reject) => {
        relayWebSocket({
          upstreamUrl: `ws://127.0.0.1:${address.port}`,
          upstreamApiKey: 'test-key',
          downstreamSocket: downstream as unknown as WebSocket,
          metadata: {
            virtualKeyId: 'vk_test',
            providerId: 'provider_test',
            model: 'model_test',
            upstreamBaseUrl: 'http://127.0.0.1',
            path: '/responses',
            clientIp: '127.0.0.1',
            userAgent: 'test',
            startTime: Date.now(),
          },
          onClose: resolve,
        }).catch(reject);
      });

      expect(tokenUsage).toEqual({
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
        cachedTokens: 0,
      });
    } finally {
      server.close();
      await activeConnectionTracker.closeAll();
    }
  });

  it('should clear connection timeout after successful open', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.on('listening', resolve));

    const address = server.address() as AddressInfo;
    server.on('connection', (upstream) => {
      upstream.close(1000, 'done');
    });

    const downstream = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send() {},
      close() {
        downstream.readyState = WebSocket.CLOSED;
        downstream.emit('close', 1000, Buffer.from(''));
      },
    }) as EventEmitter & { readyState: number; send: () => void; close: (code?: number, reason?: string) => void };

    const originalClearTimeout = global.clearTimeout;
    let clearTimeoutCallCount = 0;
    global.clearTimeout = (...args: any[]) => {
      clearTimeoutCallCount++;
      return originalClearTimeout.apply(global, args as any);
    };

    try {
      await relayWebSocket({
        upstreamUrl: `ws://127.0.0.1:${address.port}`,
        upstreamApiKey: 'test-key',
        downstreamSocket: downstream as unknown as WebSocket,
        metadata: {
          virtualKeyId: 'vk_test',
          providerId: 'provider_test',
          model: 'model_test',
          upstreamBaseUrl: 'http://127.0.0.1',
          path: '/responses',
          clientIp: '127.0.0.1',
          userAgent: 'test',
          startTime: Date.now(),
        },
      });

      expect(clearTimeoutCallCount).toBeGreaterThan(0);
    } finally {
      global.clearTimeout = originalClearTimeout;
      server.close();
      await activeConnectionTracker.closeAll();
    }
  });
});
