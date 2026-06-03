import { PassThrough } from 'stream';
import type { WebSocket as FastifyWebSocket } from '@fastify/websocket';
import { WebSocket } from 'ws';
import { ProtocolAdapter } from './protocol-adapter.js';
import type { ProtocolConfig } from './protocol-adapter.js';
import type { StreamTokenUsage } from '../routes/proxy/http-client.js';
import { memoryLogger } from './logger.js';

const defaultProtocolAdapter = new ProtocolAdapter();

const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'error',
  'response.error',
]);

class BridgeStream extends PassThrough {
  headersSent = true;

  writeHead(_statusCode: number, _headers: Record<string, string>): void {
    // no-op: headers are not needed for WebSocket bridge
  }
}

export interface BridgeOptions {
  config: ProtocolConfig;
  requestBody: any;
  socket: FastifyWebSocket;
  abortController: AbortController;
  logPrefix: string;
  maxDurationMs?: number;
  adapter?: ProtocolAdapter;
}

function parseSseEvents(buffer: string): { events: any[]; remainder: string } {
  const events: any[] = [];
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() ?? '';

  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split('\n');
    let dataLine: string | undefined;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataLine = line.slice(6);
      }
    }
    if (dataLine && dataLine !== '[DONE]') {
      try {
        events.push(JSON.parse(dataLine));
      } catch {
        // skip invalid JSON
      }
    }
  }

  return { events, remainder };
}

export async function bridgeResponsesWebSocket(
  options: BridgeOptions
): Promise<StreamTokenUsage> {
  const { config, requestBody, socket, abortController, logPrefix, maxDurationMs, adapter } = options;
  const protocolAdapter = adapter ?? defaultProtocolAdapter;

  const input = requestBody?.input ?? '';
  const bridgeOptions = { ...requestBody };
  delete bridgeOptions.type;
  delete bridgeOptions.input;
  delete bridgeOptions.stream;

  const fakeReply = { raw: new BridgeStream() };
  let sseBuffer = '';
  let closed = false;

  function closeSocket(code: number, reason: string) {
    if (closed) return;
    closed = true;
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(code, reason);
      }
    } catch {
      // ignore
    }
  }

  function sendErrorEvent(message: string, code?: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const errorEvent = {
      type: 'error',
      error: {
        message,
        type: 'bridge_error',
        param: null,
        code: code ?? 'bridge_error',
      },
    };
    try {
      socket.send(JSON.stringify(errorEvent));
    } catch {
      // ignore
    }
  }

  const streamPromise = new Promise<StreamTokenUsage>((resolve, reject) => {
    fakeReply.raw.on('data', (chunk: Buffer) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;

      sseBuffer += chunk.toString('utf-8');
      const { events, remainder } = parseSseEvents(sseBuffer);
      sseBuffer = remainder;

      for (const event of events) {
        try {
          socket.send(JSON.stringify(event));
        } catch (err: any) {
          memoryLogger.warn(`${logPrefix} | Failed to send WS frame: ${err.message}`, 'Bridge');
          closeSocket(1011, 'ws_send_error');
          reject(new Error('WebSocket send failed'));
          return;
        }

        if (TERMINAL_EVENT_TYPES.has(event?.type)) {
          memoryLogger.info(`${logPrefix} | Terminal event received: ${event.type}`, 'Bridge');
          closeSocket(1000, 'stream_complete');
          // Note: tokenUsage will be resolved by the outer promise
        }
      }
    });

    fakeReply.raw.on('end', () => {
      // If there's remaining buffer after stream ends, try to parse it
      if (sseBuffer.trim()) {
        const { events } = parseSseEvents(sseBuffer + '\n\n');
        for (const event of events) {
          if (socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify(event));
            } catch {
              // ignore
            }
          }
          if (TERMINAL_EVENT_TYPES.has(event?.type)) {
            closeSocket(1000, 'stream_complete');
          }
        }
      }
    });

    fakeReply.raw.on('error', (err: Error) => {
      memoryLogger.error(`${logPrefix} | Bridge stream error: ${err.message}`, 'Bridge');
      sendErrorEvent(err.message, 'stream_error');
      closeSocket(1011, 'stream_error');
      reject(err);
    });

    protocolAdapter
      .streamResponse(config, input, bridgeOptions, fakeReply as any, abortController.signal)
      .then((usage: StreamTokenUsage) => {
        if (!closed) {
          closeSocket(1000, 'stream_complete');
        }
        resolve(usage);
      })
      .catch((err: any) => {
        memoryLogger.error(`${logPrefix} | Upstream stream error: ${err.message}`, 'Bridge');
        sendErrorEvent(err.message, 'upstream_error');
        closeSocket(1011, 'upstream_error');
        reject(err);
      });
  });

  // Max duration timer
  let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  if (maxDurationMs && maxDurationMs > 0) {
    maxDurationTimer = setTimeout(() => {
      memoryLogger.info(`${logPrefix} | Max duration reached, aborting`, 'Bridge');
      abortController.abort();
      sendErrorEvent('Max duration exceeded', 'max_duration');
      closeSocket(1000, 'max_duration_reached');
    }, maxDurationMs);
  }

  try {
    return await streamPromise;
  } finally {
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
    }
    fakeReply.raw.destroy();
  }
}
