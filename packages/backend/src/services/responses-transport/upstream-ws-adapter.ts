/**
 * Upstream WebSocket adapter.
 *
 * Connects to an upstream Responses WebSocket endpoint, sends
 * `response.create`, and yields each received JSON event as a
 * `ResponsesServerEvent`.
 */

import NodeWebSocket from 'ws';
import type { ProtocolConfig } from '../protocol-adapter.js';
import type {
  ResponsesServerEvent,
  NormalizedResponsesRequest,
  ResponsesStreamResult,
} from '../responses-transport/types.js';
import { deriveWebSocketUrl } from '../websocket-proxy.js';
import { upstreamSslConfigService } from '../upstream-ssl-config.js';
import { memoryLogger } from '../logger.js';
import { isTerminalEvent } from '../responses-transport/helpers.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';

const WS_CONNECT_TIMEOUT_MS = 30000;

function createUpstreamWebSocket(
  wsUrl: string,
  apiKey: string | undefined,
  skipVerify: boolean
): NodeWebSocket {
  const wsOptions: NodeWebSocket.ClientOptions = {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
    },
  };
  if (skipVerify) {
    (wsOptions as any).rejectUnauthorized = false;
  }
  return new NodeWebSocket(wsUrl, [], wsOptions);
}

export async function* streamUpstreamWebSocket(
  config: ProtocolConfig,
  request: NormalizedResponsesRequest,
  abortSignal: AbortSignal
): AsyncGenerator<ResponsesServerEvent, ResponsesStreamResult, unknown> {
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error('Provider base URL is required for WebSocket streaming');
  }

  const wsUrl = deriveWebSocketUrl(baseUrl, '/responses');
  const apiKey = config.apiKey;

  const createEvent: any = {
    ...request.body,
    type: 'response.create',
    model: config.model || request.body?.model,
  };
  delete createEvent.stream;
  // background is removed to match existing responses-ws-adapter behaviour;
  // upstream WebSocket endpoints may not accept this field.
  delete createEvent.background;

  const skipVerify = upstreamSslConfigService.isSkipVerify();
  const upstreamSocket = createUpstreamWebSocket(wsUrl, apiKey, skipVerify);

  const startedAt = Date.now();
  let tffbMs: number | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let terminalEventReceived = false;
  let terminalEventType: string | undefined;
  let closed = false;

  const logPrefix = `UpstreamWS | model=${config.model}`;

  function closeSocket(code?: number, reason?: string) {
    if (closed) return;
    closed = true;
    try {
      upstreamSocket.close(code, reason);
    } catch (_e) {}
  }

  let abortHandler: (() => void) | undefined;
  if (abortSignal) {
    abortHandler = () => {
      closeSocket(1001, 'aborted');
    };
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const messageQueue: ResponsesServerEvent[] = [];
  let queueResolver: (() => void) | null = null;
  let finished = false;
  let finishError: Error | null = null;

  function pushEvent(event: ResponsesServerEvent) {
    messageQueue.push(event);
    if (queueResolver) {
      queueResolver();
      queueResolver = null;
    }
  }

  function finishStream() {
    if (finished) return;
    finished = true;
    if (queueResolver) {
      queueResolver();
      queueResolver = null;
    }
  }

  function failStream(err: Error) {
    if (finished) return;
    finishError = err;
    finished = true;
    if (queueResolver) {
      queueResolver();
      queueResolver = null;
    }
  }

  const connectTimeout = setTimeout(() => {
    failStream(new Error('WebSocket connection timeout'));
    closeSocket();
  }, WS_CONNECT_TIMEOUT_MS);

  upstreamSocket.on('open', () => {
    clearTimeout(connectTimeout);
    upstreamSocket.send(JSON.stringify(createEvent));
  });

  upstreamSocket.on('message', (data, _isBinary) => {
    if (finished || closed) return;

    if (tffbMs === undefined) {
      tffbMs = Date.now() - startedAt;
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
      messageStr = Buffer.concat(data as any).toString('utf-8');
    }

    let event: ResponsesServerEvent;
    try {
      event = JSON.parse(messageStr) as ResponsesServerEvent;
    } catch (e) {
      memoryLogger.warn(`${logPrefix} | Invalid JSON from upstream WS: ${messageStr.slice(0, 200)}`, 'UpstreamWS');
      return;
    }

    if (event && typeof event === 'object' && 'instructions' in event) {
      delete (event as any).instructions;
    }

    pushEvent(event);

    const usage = (event as any)?.usage ?? (event as any)?.response?.usage;
    if (usage) {
      const norm = normalizeUsageCounts(usage);
      if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) promptTokens = norm.promptTokens;
      if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) completionTokens = norm.completionTokens;
      if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) totalTokens = norm.totalTokens;
      else if (promptTokens > 0 || completionTokens > 0) totalTokens = promptTokens + completionTokens;
      if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) cachedTokens = norm.cachedTokens;
    }

    if (isTerminalEvent(event)) {
      terminalEventReceived = true;
      terminalEventType = event.type;
      finishStream();
    }
  });

  upstreamSocket.on('error', (err) => {
    clearTimeout(connectTimeout);
    failStream(new Error(`Upstream WebSocket error: ${err?.message || String(err)}`));
    closeSocket();
  });

  upstreamSocket.on('close', (_code, _reason) => {
    clearTimeout(connectTimeout);
    if (terminalEventReceived || abortSignal.aborted || finishError) {
      finishStream();
      return;
    }
    failStream(new Error('Upstream WebSocket closed before terminal event'));
  });

  try {
    while (!finished || messageQueue.length > 0) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
        continue;
      }

      if (finished) {
        break;
      }

      await new Promise<void>((resolve) => {
        queueResolver = resolve;
      });
    }

    if (finishError) {
      throw finishError;
    }
  } finally {
    closeSocket();
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }

  return {
    tokenUsage: { promptTokens, completionTokens, totalTokens, cachedTokens },
    tffbMs,
    terminalEventReceived,
    terminalEventType,
    transportMode: 'ws_to_ws',
  };
}
