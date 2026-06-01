import WebSocket from 'ws';
import { memoryLogger } from './logger.js';
import { upstreamSslConfigService } from './upstream-ssl-config.js';
import { isBun } from '../utils/upstream-proxy.js';
import { normalizeUsageCounts } from '../utils/usage-normalizer.js';

export interface WebSocketConnectionMetadata {
  virtualKeyId: string;
  virtualKeyName?: string;
  providerId: string;
  model: string;
  upstreamBaseUrl: string;
  path: string;
  clientIp: string;
  userAgent: string;
  startTime: number;
}

export interface WebSocketRelayOptions {
  upstreamUrl: string;
  upstreamApiKey: string;
  downstreamSocket: WebSocket;
  metadata: WebSocketConnectionMetadata;
  onClose?: (tokenUsage: WebSocketTokenUsage) => void;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface WebSocketTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

function createEmptyTokenUsage(): WebSocketTokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
}

class ActiveConnectionTracker {
  private connections = new Set<WebSocket>();
  private closeTimeoutMs = 2000;

  add(socket: WebSocket) {
    this.connections.add(socket);
  }

  remove(socket: WebSocket) {
    this.connections.delete(socket);
  }

  get count() {
    return this.connections.size;
  }

  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const socket of this.connections) {
      promises.push(this.closeSocket(socket));
    }
    await Promise.all(promises);
    this.connections.clear();
  }

  private closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout | null = null;

      const finish = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        socket.off('close', finish);
        resolve();
      };

      socket.once('close', finish);
      timeout = setTimeout(finish, this.closeTimeoutMs);

      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close(1001, 'Server shutting down');
        } catch (_e) {
          finish();
        }
      }
    });
  }
}

export const activeConnectionTracker = new ActiveConnectionTracker();

export function deriveWebSocketUrl(httpBaseUrl: string, path: string): string {
  let url = httpBaseUrl.trim().replace(/\/+$/, '');

  if (url.startsWith('https://')) {
    url = 'wss://' + url.slice(8);
  } else if (url.startsWith('http://')) {
    url = 'ws://' + url.slice(7);
  } else if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    url = 'wss://' + url;
  }

  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  return url + normalizedPath;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10MB

export async function relayWebSocket(options: WebSocketRelayOptions): Promise<void> {
  const { upstreamUrl, upstreamApiKey, downstreamSocket, metadata, onClose, maxDurationMs, idleTimeoutMs, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = options;

  const skipVerify = upstreamSslConfigService.isSkipVerify();
  const wsOptions: WebSocket.ClientOptions = {
    headers: {
      'Authorization': `Bearer ${upstreamApiKey}`,
    },
  };
  if (skipVerify) {
    if (isBun()) {
      (wsOptions as any).tls = { rejectUnauthorized: false };
    } else {
      (wsOptions as any).rejectUnauthorized = false;
    }
  }
  const upstreamSocket = new WebSocket(upstreamUrl, [], wsOptions);

  const logPrefix = `WS relay | vk=${metadata.virtualKeyName || metadata.virtualKeyId} | provider=${metadata.providerId} | model=${metadata.model}`;

  memoryLogger.info(`${logPrefix} | Connecting upstream: ${upstreamUrl}`, 'WebSocket');

  try {
    await new Promise<void>((resolve, reject) => {
      let connectTimeout: NodeJS.Timeout | null = null;

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Upstream connection failed: ${err.message}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Upstream connection closed before open'));
      };

      const cleanup = () => {
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = null;
        }
        upstreamSocket.off('open', onOpen);
        upstreamSocket.off('error', onError);
        upstreamSocket.off('close', onClose);
      };

      upstreamSocket.on('open', onOpen);
      upstreamSocket.on('error', onError);
      upstreamSocket.on('close', onClose);

      // Safety timeout for connection establishment
      connectTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Upstream connection timeout'));
      }, 30000);
    });
  } catch (connectError: any) {
    memoryLogger.error(`${logPrefix} | ${connectError.message}`, 'WebSocket');
    try {
      if (downstreamSocket.readyState === WebSocket.OPEN) {
        downstreamSocket.close(1011, 'upstream_connect_failed');
      }
    } catch (_e) {}
    onClose?.(createEmptyTokenUsage());
    throw connectError;
  }

  memoryLogger.info(`${logPrefix} | Upstream connected`, 'WebSocket');

  activeConnectionTracker.add(downstreamSocket);
  activeConnectionTracker.add(upstreamSocket);

  let maxDurationTimer: NodeJS.Timeout | null = null;
  if (maxDurationMs && maxDurationMs > 0) {
    maxDurationTimer = setTimeout(() => {
      memoryLogger.info(`${logPrefix} | Max duration reached, closing connection`, 'WebSocket');
      closeBoth(1000, 'max_duration_reached');
    }, maxDurationMs);
  }

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleTimeoutMs && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        memoryLogger.info(`${logPrefix} | Idle timeout, closing connection`, 'WebSocket');
        closeBoth(1000, 'idle_timeout');
      }, idleTimeoutMs);
    }
  };
  resetIdleTimer();

  let closed = false;
  const tokenUsage = createEmptyTokenUsage();

  function closeBoth(code: number, reason: string) {
    if (closed) return;
    closed = true;

    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    closeDownstream(code, reason);
    closeUpstream(code, reason);

    activeConnectionTracker.remove(downstreamSocket);
    activeConnectionTracker.remove(upstreamSocket);

    const duration = Date.now() - metadata.startTime;
    memoryLogger.info(
      `${logPrefix} | Connection closed | duration=${duration}ms | code=${code} | reason=${reason}`,
      'WebSocket'
    );

    onClose?.(tokenUsage);
  }

  function closeDownstream(code: number, reason: string) {
    try {
      if (downstreamSocket.readyState === WebSocket.OPEN) {
        downstreamSocket.close(code, reason);
      }
    } catch (_e) {}
  }

  function closeUpstream(code: number, reason: string) {
    try {
      if (upstreamSocket.readyState === WebSocket.OPEN) {
        upstreamSocket.close(code, reason);
      }
    } catch (_e) {}
  }

  function getPayloadSize(data: WebSocket.RawData): number {
    if (Buffer.isBuffer(data)) return data.length;
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (Array.isArray(data)) return data.reduce((sum, buf) => sum + buf.length, 0);
    return 0;
  }

  function rawDataToString(data: WebSocket.RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf-8');
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
    return Buffer.concat(data).toString('utf-8');
  }

  function recordUpstreamUsage(data: WebSocket.RawData, isBinary: boolean) {
    if (isBinary) return;

    let event: any;
    try {
      event = JSON.parse(rawDataToString(data));
    } catch (_e) {
      return;
    }

    const usage = event?.usage ?? event?.response?.usage;
    if (!usage) return;

    const normalized = normalizeUsageCounts(usage);
    if (normalized.promptTokens > 0) tokenUsage.promptTokens = normalized.promptTokens;
    if (normalized.completionTokens > 0) tokenUsage.completionTokens = normalized.completionTokens;
    if (normalized.totalTokens > 0) tokenUsage.totalTokens = normalized.totalTokens;
    if (normalized.cachedTokens > 0) tokenUsage.cachedTokens = normalized.cachedTokens;
  }

  const handleDownstreamMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    resetIdleTimer();
    const size = getPayloadSize(data);
    if (size > maxPayloadBytes) {
      memoryLogger.warn(`${logPrefix} | Downstream payload too large: ${size} bytes (max=${maxPayloadBytes})`, 'WebSocket');
      closeBoth(1009, 'payload_too_large');
      return;
    }
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
    }
  };

  const handleUpstreamMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    resetIdleTimer();
    const size = getPayloadSize(data);
    if (size > maxPayloadBytes) {
      memoryLogger.warn(`${logPrefix} | Upstream payload too large: ${size} bytes (max=${maxPayloadBytes})`, 'WebSocket');
      closeBoth(1009, 'payload_too_large');
      return;
    }
    if (downstreamSocket.readyState === WebSocket.OPEN) {
      recordUpstreamUsage(data, isBinary);
      downstreamSocket.send(data, { binary: isBinary });
    }
  };

  const handleDownstreamClose = (code: number, reason: Buffer) => {
    memoryLogger.info(`${logPrefix} | Downstream closed: code=${code} reason=${reason.toString()}`, 'WebSocket');
    closeBoth(code, reason.toString());
  };

  const handleUpstreamClose = (code: number, reason: Buffer) => {
    memoryLogger.info(`${logPrefix} | Upstream closed: code=${code} reason=${reason.toString()}`, 'WebSocket');
    closeBoth(code, reason.toString());
  };

  const handleDownstreamError = (error: Error) => {
    memoryLogger.error(`${logPrefix} | Downstream error: ${error.message}`, 'WebSocket');
    closeBoth(1011, 'downstream_error');
  };

  const handleUpstreamError = (error: Error) => {
    memoryLogger.error(`${logPrefix} | Upstream error: ${error.message}`, 'WebSocket');
    closeBoth(1011, 'upstream_error');
  };

  downstreamSocket.on('message', handleDownstreamMessage);
  downstreamSocket.on('close', handleDownstreamClose);
  downstreamSocket.on('error', handleDownstreamError);

  upstreamSocket.on('message', handleUpstreamMessage);
  upstreamSocket.on('close', handleUpstreamClose);
  upstreamSocket.on('error', handleUpstreamError);
}
