import NodeWebSocket from 'ws';
import type { FastifyReply } from 'fastify';
import type { ProtocolConfig } from './protocol-adapter.js';
import type { StreamTokenUsage } from '../routes/proxy/http-client.js';
import { deriveWebSocketUrl } from './websocket-proxy.js';
import { memoryLogger } from './logger.js';
import { upstreamSslConfigService } from './upstream-ssl-config.js';
import { normalizeUsageCounts } from '../utils/usage-normalizer.js';
import { stripFieldRecursively } from '../utils/request-logger.js';

const WS_CONNECT_TIMEOUT_MS = 30000;

function createUpstreamWebSocket(wsUrl: string, apiKey: string | undefined, skipVerify: boolean): NodeWebSocket {
  const wsOptions: NodeWebSocket.ClientOptions = {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  };
  if (skipVerify) {
    (wsOptions as any).rejectUnauthorized = false;
  }
  return new NodeWebSocket(wsUrl, [], wsOptions);
}

function onSocketEvent(socket: NodeWebSocket, event: 'open' | 'message' | 'error' | 'close', handler: (...args: any[]) => void) {
  socket.on(event, handler);
}

function socketErrorMessage(error: any): string {
  return error?.message || error?.error?.message || String(error);
}

export async function streamResponsesViaWebSocket(
  config: ProtocolConfig,
  requestBody: any,
  reply: FastifyReply,
  abortSignal?: AbortSignal
): Promise<StreamTokenUsage> {
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error('Provider base URL is required for WebSocket streaming');
  }

  const wsUrl = deriveWebSocketUrl(baseUrl, '/responses');
  const apiKey = config.apiKey;

  const createEvent: any = {
    ...requestBody,
    type: 'response.create',
    model: config.model || requestBody?.model,
  };
  delete createEvent.stream;
  delete createEvent.background;

  const skipVerify = upstreamSslConfigService.isSkipVerify();
  const upstreamSocket = createUpstreamWebSocket(wsUrl, apiKey, skipVerify);

  const startTime = Date.now();
  let tffbMs: number | undefined;
  const streamChunks: string[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let headersSent = false;
  let closed = false;

  const logPrefix = `ResponsesWS | model=${config.model}`;

  function ensureHeaders() {
    if (!headersSent && !reply.raw.headersSent) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      headersSent = true;
    }
  }

  function closeSocket(code?: number, reason?: string) {
    if (closed) return;
    closed = true;
    try {
      upstreamSocket.close(code, reason);
    } catch (_e) {}
  }

  function writeSse(event: any) {
    ensureHeaders();
    const eventName = typeof event?.type === 'string' ? event.type : undefined;
    const prefix = eventName ? `event: ${eventName}\n` : '';
    const data = `${prefix}data: ${JSON.stringify(event)}\n\n`;
    streamChunks.push(data);
    reply.raw.write(data);
  }

  let abortHandler: (() => void) | undefined;
  if (abortSignal) {
    abortHandler = () => {
      closeSocket(1000, 'aborted');
    };
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  return new Promise<StreamTokenUsage>((resolve, reject) => {
    const connectTimeout = setTimeout(() => {
      closeSocket();
      reject(new Error('WebSocket connection timeout'));
    }, WS_CONNECT_TIMEOUT_MS);

    onSocketEvent(upstreamSocket, 'open', () => {
      clearTimeout(connectTimeout);
      upstreamSocket.send(JSON.stringify(createEvent));
    });

    onSocketEvent(upstreamSocket, 'message', (data, _isBinary) => {
      if (closed) return;

      if (tffbMs === undefined) {
        tffbMs = Date.now() - startTime;
      }

      let messageStr: string;
      if (Buffer.isBuffer(data)) {
        messageStr = data.toString('utf-8');
      } else if (typeof data === 'string') {
        messageStr = data;
      } else if (data instanceof ArrayBuffer) {
        messageStr = Buffer.from(data).toString('utf-8');
      } else if (ArrayBuffer.isView(data)) {
        messageStr = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
      } else {
        messageStr = Buffer.concat(data).toString('utf-8');
      }

      let event: any;
      try {
        event = JSON.parse(messageStr);
      } catch (e) {
        memoryLogger.warn(`${logPrefix} | Invalid JSON from upstream WS: ${messageStr.slice(0, 200)}`, 'ResponsesWS');
        return;
      }

      try {
        stripFieldRecursively(event, 'instructions');
      } catch (_e) {}

      writeSse(event);

      const usage = event?.usage ?? event?.response?.usage;
      if (usage) {
        const norm = normalizeUsageCounts(usage);
        if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) promptTokens = norm.promptTokens;
        if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) completionTokens = norm.completionTokens;
        if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) {
          totalTokens = norm.totalTokens;
        } else if (promptTokens > 0 || completionTokens > 0) {
          totalTokens = promptTokens + completionTokens;
        }
        if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) cachedTokens = norm.cachedTokens;
      }

      const eventType = event?.type;
      const terminalTypes = new Set([
        'response.completed',
        'response.failed',
        'response.incomplete',
        'response.cancelled',
        'error',
        'response.error',
      ]);
      if (terminalTypes.has(eventType)) {
        closeSocket();
        if (!reply.raw.writableEnded) {
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        }
        resolve({
          promptTokens,
          completionTokens,
          totalTokens,
          cachedTokens,
          streamChunks,
          tffbMs,
        });
      }
    });

    onSocketEvent(upstreamSocket, 'error', (err) => {
      clearTimeout(connectTimeout);
      closeSocket();
      reject(new Error(`Upstream WebSocket error: ${socketErrorMessage(err)}`));
    });

    onSocketEvent(upstreamSocket, 'close', (_code, _reason) => {
      clearTimeout(connectTimeout);
      if (!closed) {
        closed = true;
        if (!reply.raw.writableEnded) {
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        }
        resolve({
          promptTokens,
          completionTokens,
          totalTokens,
          cachedTokens,
          streamChunks,
          tffbMs,
        });
      }
    });
  }).finally(() => {
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  });
}
