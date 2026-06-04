import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import { WebSocket } from 'ws';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { virtualKeyQueueService } from '../../services/virtual-key-queue.js';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
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
import type { ResponsesStreamResult } from '../../services/responses-transport/types.js';

export async function registerResponsesWebSocketRoutes(fastify: FastifyInstance) {
  const preHandler = async (request: FastifyRequest, reply: any) => {
    const result = await runProxyPipeline(request, reply, {
      protocol: 'openai',
      handlers: {
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
        onModelError: ({ reply: r, modelError }) => {
          r.code(modelError.code).send(modelError.body);
        },
        onProviderConfigError: ({ reply: r, providerConfigError }) => {
          r.code(providerConfigError.code).send(providerConfigError.body);
        },
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
  context: any
): Promise<void> {
  const {
    requestIp,
    requestUserAgent,
    virtualKey,
    virtualKeyValue,
    provider,
    providerId,
    currentModel,
  } = context;

  const vkDisplay = virtualKeyValue && virtualKeyValue.length > 10
    ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
    : virtualKeyValue;

  const logPrefix = `WS handler | vk=${vkDisplay} | provider=${providerId}`;

  let socketClosedEarly = false;
  socket.once('close', () => { socketClosedEarly = true; });

  try {
    const configResult = await buildProviderConfig(provider, virtualKey, virtualKeyValue, providerId, request, currentModel);
    if (socketClosedEarly) return;

    if ('code' in configResult) {
      memoryLogger.error(`${logPrefix} | Provider config error: ${configResult.body.error.message}`, 'WebSocket');
      sendErrorAndClose(socket, configResult.body.error.message, ERROR_CODES.PROVIDER_CONFIG_ERROR, WS_CLOSE_CODES.POLICY_VIOLATION);
      return;
    }

    const { protocolConfig, path } = configResult;

    if (protocolConfig.protocol !== 'openai') {
      memoryLogger.error(
        `${logPrefix} | Provider protocol '${protocolConfig.protocol}' does not support WebSocket transport`,
        'WebSocket'
      );
      sendErrorAndClose(socket, 'Provider protocol does not support WebSocket transport', ERROR_CODES.UNSUPPORTED_CLIENT_EVENT, WS_CLOSE_CODES.POLICY_VIOLATION);
      return;
    }

    if (!protocolConfig.baseUrl) {
      memoryLogger.error(`${logPrefix} | Provider has no base URL configured`, 'WebSocket');
      sendErrorAndClose(socket, 'Provider has no base URL configured', ERROR_CODES.MISSING_UPSTREAM, WS_CLOSE_CODES.POLICY_VIOLATION);
      return;
    }

    if (!protocolConfig.apiKey) {
      memoryLogger.error(`${logPrefix} | Provider has no API key configured`, 'WebSocket');
      sendErrorAndClose(socket, 'Provider has no API key configured', ERROR_CODES.MISSING_UPSTREAM, WS_CLOSE_CODES.POLICY_VIOLATION);
      return;
    }

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

      try {
        const normalizedRequest = normalizeResponseCreate(requestBody);
        const mode = resolveTransportMode(true, protocolConfig.upstreamTransport ?? 'http_sse');

        memoryLogger.info(`${logPrefix} | Transport mode: ${mode}`, 'WebSocket');

        const maxDurationTimer = maxDurationMs > 0
          ? setTimeout(() => {
              memoryLogger.info(`${logPrefix} | Max duration reached, aborting`, 'WebSocket');
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

        logApiRequestToDb({
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
        }).catch((_e) => {});
      } catch (err: any) {
        memoryLogger.error(`${logPrefix} | Response error: ${err?.message || String(err)}`, 'WebSocket');

        const duration = Date.now() - turnStartTime;
        logApiRequestToDb({
          virtualKey,
          providerId,
          model: protocolConfig.model || 'unknown',
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: 'error',
          responseTime: duration,
          requestType: 'openai-responses-ws',
          ip: requestIp,
          userAgent: requestUserAgent,
        }).catch((_e) => {});

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
    socket.on('message', (data, isBinary) => {
      handleClientMessage(data, isBinary).catch((err: any) => {
        memoryLogger.error(`${logPrefix} | ${err?.message || String(err)}`, 'WebSocket');
        sendErrorAndClose(socket, err?.message || 'Handler error', ERROR_CODES.HANDLER_ERROR, WS_CLOSE_CODES.INTERNAL_ERROR);
      });
    });

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
