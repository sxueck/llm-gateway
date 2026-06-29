import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import { WebSocket } from 'ws';
import { runProxyPreflight, type ProxyPreflightContext } from '../proxy/pipeline.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { virtualKeyQueueService } from '../../services/virtual-key-queue.js';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { nanoid } from 'nanoid';
import {
  parseClientWebSocketEvent,
  normalizeResponseCreate,
  buildErrorEvent,
  buildQueueError,
  ERROR_CODES,
  WS_CLOSE_CODES,
} from '../../services/responses-transport/index.js';
import { resolveTransportMode } from '../../services/responses-transport/mode-resolver.js';
import { runResponsesTransport } from '../../services/responses-transport/orchestrator.js';
import { writeEventsToWebSocket } from '../../services/responses-transport/downstream-ws-writer.js';
import type { NormalizedResponsesRequest, ResponsesStreamResult } from '../../services/responses-transport/types.js';

export interface WsTurnConfig {
  provider: any;
  providerId: string;
  currentModel?: any;
  protocolConfig: any;
  path: string;
}

export async function registerResponsesWebSocketRoutes(fastify: FastifyInstance) {
  const preHandler = async (request: FastifyRequest, reply: any) => {
    const result = await runProxyPreflight(request, reply, {
      onManualBlock: ({ reply: r }) => {
        r.code(403).send({
          error: {
            message: 'Access denied: IP blocked',
            type: 'access_denied',
            param: 'ip',
            code: 'ip_blocked',
          },
        });
      },
      onAntiBotBlock: ({ reply: r }) => {
        r.code(403).send({
          error: {
            message: 'Access denied: Bot detected',
            type: 'access_denied',
            param: 'user-agent',
            code: 'bot_detected',
          },
        });
      },
      onAuthError: ({ reply: r, authError }) => {
        r.code(authError.code).send(authError.body);
      },
    });

    if (!result.ok) {
      return;
    }

    (request as any).wsProxyContext = result.context;
  };

  const wsHandler = async (socket: WsWebSocket, request: FastifyRequest) => {
    const context = (request as any).wsProxyContext;
    if (!context) {
      socket.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'missing_proxy_context');
      return;
    }

    await handleResponsesWebSocket(socket, request, context);
  };

  fastify.get('/responses', { websocket: true, preHandler }, wsHandler);
  fastify.get('/v1/responses', { websocket: true, preHandler }, wsHandler);
}

export async function handleResponsesWebSocket(
  socket: WsWebSocket,
  request: FastifyRequest,
  context: ProxyPreflightContext
): Promise<void> {
  const {
    requestIp,
    requestUserAgent,
    virtualKey,
    virtualKeyValue,
  } = context;

  const vkDisplay = virtualKeyValue && virtualKeyValue.length > 10
    ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
    : virtualKeyValue;

  const logPrefix = `WS handler | vk=${vkDisplay}`;

  const pendingMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  let dispatchMessage: ((data: WebSocket.RawData, isBinary: boolean) => void) | null = null;

  socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (dispatchMessage) {
      dispatchMessage(data, isBinary);
    } else {
      pendingMessages.push({ data, isBinary });
    }
  });

  let socketClosedEarly = false;
  socket.once('close', () => { socketClosedEarly = true; });

  try {
    if (socketClosedEarly) return;

    const maxDurationMs = 10 * 60 * 1000;
    const idleTimeoutMs = 5 * 60 * 1000;
    let inFlight = false;
    let activeAbortController: AbortController | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            sendErrorAndClose(socket, 'Idle timeout', ERROR_CODES.IDLE_TIMEOUT, WS_CLOSE_CODES.INTERNAL_ERROR);
          }
        } catch (_e) {}
      }, idleTimeoutMs);
    }

    async function handleCancel() {
      if (!inFlight) {
        sendGatewayError(socket, 'No response is in progress', ERROR_CODES.NOTHING_TO_CANCEL);
        return;
      }

      memoryLogger.info(`${logPrefix} | Cancelling in-flight response`, 'WebSocket');
      if (activeAbortController) {
        activeAbortController.abort();
      }
      // The orchestrator will emit response.cancelled or error and return;
      // queue release happens in the finally block of handleResponseCreate.
    }

    async function handleResponseCreate(requestBody: any) {
      if (inFlight) {
        sendGatewayError(socket, 'A response is already in progress on this WebSocket', ERROR_CODES.RESPONSE_IN_PROGRESS);
        return;
      }

      inFlight = true;
      const turnStartTime = Date.now();
      const abortController = new AbortController();
      activeAbortController = abortController;
      const closeAbortHandler = () => abortController.abort();
      socket.once('close', closeAbortHandler);

      const acquireResult = await virtualKeyQueueService.acquire(virtualKeyValue, abortController.signal);
      if (!acquireResult.granted) {
        memoryLogger.warn(`${logPrefix} | Queue rejected: ${acquireResult.reason}`, 'WebSocket');
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(buildQueueError(acquireResult.reason)));
        }
        socket.off('close', closeAbortHandler);
        inFlight = false;
        activeAbortController = undefined;
        return;
      }

      let result: ResponsesStreamResult | undefined;
      let success = false;
      let turnConfig: WsTurnConfig | undefined;

      try {
        const normalizedRequest = normalizeResponseCreate(requestBody);
        turnConfig = await resolveWebSocketTurnConfig(
          request,
          virtualKey,
          virtualKeyValue,
          normalizedRequest
        );
        const { protocolConfig, path, providerId } = turnConfig;
        const providerLogPrefix = `${logPrefix} | provider=${providerId}`;
        const mode = resolveTransportMode(true, protocolConfig.upstreamTransport ?? 'http_sse');

        memoryLogger.info(`${providerLogPrefix} | Transport mode: ${mode}`, 'WebSocket');

        const maxDurationTimer = maxDurationMs > 0
          ? setTimeout(() => {
              memoryLogger.info(`${providerLogPrefix} | Max duration reached, aborting`, 'WebSocket');
              abortController.abort();
            }, maxDurationMs)
          : undefined;

        try {
          const eventStream = runResponsesTransport(mode, protocolConfig, normalizedRequest, abortController.signal);
          result = await writeEventsToWebSocket(eventStream, {
            socket,
            closeOnTerminal: false,
          });
          success = result.terminalEventReceived;
        } finally {
          if (maxDurationTimer) clearTimeout(maxDurationTimer);
        }

        const duration = Date.now() - turnStartTime;

        if (debugModeService.isActive()) {
          try {
            debugModeService.broadcast({
              type: 'api_request',
              id: nanoid(),
              timestamp: Date.now(),
              protocol: 'openai-responses-ws',
              method: 'WS',
              path,
              stream: true,
              success,
              statusCode: success ? 200 : 500,
              fromCache: false,
              virtualKeyId: virtualKey.id,
              virtualKeyName: (virtualKey as any).name,
              providerId,
              model: protocolConfig.model || 'unknown',
              durationMs: duration,
              requestBody: undefined,
              responseBody: undefined,
              requestHeaders: request.headers,
            });
          } catch (_e) {}
        }

        logApiRequestAsync({
          virtualKey,
          providerId,
          model: protocolConfig.model || 'unknown',
          tokenCount: result?.tokenUsage
            ? { promptTokens: result.tokenUsage.promptTokens, completionTokens: result.tokenUsage.completionTokens, totalTokens: result.tokenUsage.totalTokens }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cachedTokens: result?.tokenUsage.cachedTokens,
          status: success ? 'success' : 'error',
          responseTime: duration,
          requestType: 'openai-responses-ws',
          ip: requestIp,
          userAgent: requestUserAgent,
        });
      } catch (err: any) {
        memoryLogger.error(`${logPrefix} | Response error: ${err?.message || String(err)}`, 'WebSocket');

        const duration = Date.now() - turnStartTime;
        logApiRequestAsync({
          virtualKey,
          providerId: turnConfig?.providerId || 'unknown',
          model: turnConfig?.protocolConfig?.model || normalizedModelFromRequest(requestBody) || 'unknown',
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: 'error',
          responseTime: duration,
          requestType: 'openai-responses-ws',
          ip: requestIp,
          userAgent: requestUserAgent,
        });

        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify(buildErrorEvent(
              err?.message || 'Response error',
              err?.code || ERROR_CODES.HANDLER_ERROR
            )));
          } catch (_e) {}
          socket.close(WS_CLOSE_CODES.INTERNAL_ERROR, 'response_error');
        }
      } finally {
        acquireResult.release();
        socket.off('close', closeAbortHandler);
        inFlight = false;
        activeAbortController = undefined;
        resetIdleTimer();
      }
    }

    async function handleClientMessage(data: WebSocket.RawData, isBinary: boolean) {
      resetIdleTimer();

      let clientEvent;
      try {
        clientEvent = parseClientWebSocketEvent(data, isBinary);
      } catch (err: any) {
        const code = (err as any).code || ERROR_CODES.HANDLER_ERROR;
        const wsCloseCode = (err as any).wsCloseCode || WS_CLOSE_CODES.INTERNAL_ERROR;
        sendErrorAndClose(socket, err.message, code, wsCloseCode);
        return;
      }

      if (clientEvent.type === 'response.create') {
        await handleResponseCreate(clientEvent);
      } else if (clientEvent.type === 'response.cancel') {
        await handleCancel();
      }
    }

    resetIdleTimer();

    dispatchMessage = (data, isBinary) => {
      handleClientMessage(data, isBinary).catch((err: any) => {
        memoryLogger.error(`${logPrefix} | ${err?.message || String(err)}`, 'WebSocket');
        sendErrorAndClose(socket, err?.message || 'Handler error', ERROR_CODES.HANDLER_ERROR, WS_CLOSE_CODES.INTERNAL_ERROR);
      });
    };
    for (const pending of pendingMessages) {
      dispatchMessage(pending.data, pending.isBinary);
    }

    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        if (idleTimer) clearTimeout(idleTimer);
        resolve();
      });
    });

  } catch (err: any) {
    const errorMessage = err?.message || String(err);
    memoryLogger.error(`${logPrefix} | ${errorMessage}`, 'WebSocket');

    if (socket.readyState === WebSocket.OPEN) {
      sendErrorAndClose(socket, errorMessage, ERROR_CODES.HANDLER_ERROR, WS_CLOSE_CODES.INTERNAL_ERROR);
    }
  }
}

export async function resolveWebSocketTurnConfig(
  request: FastifyRequest,
  virtualKey: any,
  virtualKeyValue: string,
  normalizedRequest: NormalizedResponsesRequest
): Promise<WsTurnConfig> {
  const turnRequest = buildTurnRequest(request, normalizedRequest.body);
  const modelResult = await resolveModelAndProvider(virtualKey, turnRequest, virtualKeyValue);

  if ('code' in modelResult) {
    throw errorFromGatewayPayload(modelResult.body.error.message, ERROR_CODES.UNSUPPORTED_CLIENT_EVENT);
  }

  const { provider, providerId, currentModel } = modelResult;
  const configResult = await buildProviderConfig(provider, virtualKey, virtualKeyValue, providerId, turnRequest, currentModel, 'openai');

  if ('code' in configResult) {
    throw errorFromGatewayPayload(configResult.body.error.message, ERROR_CODES.PROVIDER_CONFIG_ERROR);
  }

  const { protocolConfig, path } = configResult;

  if (!protocolConfig.baseUrl) {
    throw errorFromGatewayPayload('Provider has no base URL configured', ERROR_CODES.MISSING_UPSTREAM);
  }

  if (!protocolConfig.apiKey) {
    throw errorFromGatewayPayload('Provider has no API key configured', ERROR_CODES.MISSING_UPSTREAM);
  }

  return {
    provider,
    providerId,
    currentModel,
    protocolConfig,
    path,
  };
}

function buildTurnRequest(request: FastifyRequest, body: any): FastifyRequest {
  return {
    body,
    headers: request.headers,
    url: request.url,
    method: request.method,
    protocol: 'openai',
  } as any;
}

function errorFromGatewayPayload(message: string, code: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}

function normalizedModelFromRequest(requestBody: any): string | undefined {
  if (requestBody?.type === 'response.create' && requestBody?.response && typeof requestBody.response === 'object') {
    return typeof requestBody.response.model === 'string' ? requestBody.response.model : undefined;
  }
  return typeof requestBody?.model === 'string' ? requestBody.model : undefined;
}

function sendGatewayError(socket: WsWebSocket, message: string, code: string) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(buildErrorEvent(message, code)));
  } catch (_e) {}
}

function sendErrorAndClose(socket: WsWebSocket, message: string, code: string, wsCloseCode: number) {
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(buildErrorEvent(message, code)));
    } catch (_e) {}
    try {
      socket.close(wsCloseCode, code);
    } catch (_e) {}
  }
}
