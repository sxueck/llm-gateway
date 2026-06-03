import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import { WebSocket } from 'ws';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { virtualKeyQueueService } from '../../services/virtual-key-queue.js';
import { bridgeResponsesWebSocket } from '../../services/ws-to-sse-bridge.js';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { nanoid } from 'nanoid';

function buildQueue429Error(reason: 'queue_full' | 'timeout' | 'cancelled') {
  const message = reason === 'queue_full'
    ? 'Request queue is full for this virtual key. Please try again later.'
    : reason === 'timeout'
    ? 'Request timed out waiting in queue. Please try again later.'
    : 'Request was cancelled while waiting in queue.';
  return {
    error: {
      message,
      type: 'rate_limit_error',
      param: null,
      code: `queue_${reason}`,
    },
  };
}

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
      socket.close(1011, 'missing_proxy_context');
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
      socket.close(1011, 'provider_config_error');
      return;
    }

    const { protocolConfig, path } = configResult;

    if (protocolConfig.protocol !== 'openai') {
      memoryLogger.error(
        `${logPrefix} | Provider protocol '${protocolConfig.protocol}' does not support WebSocket transport`,
        'WebSocket'
      );
      socket.close(1008, 'unsupported_transport');
      return;
    }

    if (!protocolConfig.baseUrl) {
      memoryLogger.error(`${logPrefix} | Provider has no base URL configured`, 'WebSocket');
      socket.close(1008, 'missing_upstream_url');
      return;
    }

    if (!protocolConfig.apiKey) {
      memoryLogger.error(`${logPrefix} | Provider has no API key configured`, 'WebSocket');
      socket.close(1008, 'missing_upstream_key');
      return;
    }

    const maxDurationMs = 10 * 60 * 1000;
    const idleTimeoutMs = 5 * 60 * 1000;
    let inFlight = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1000, 'idle_timeout');
          }
        } catch (_e) {}
      }, idleTimeoutMs);
    }

    function sendGatewayError(message: string, code: string) {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({
          type: 'error',
          error: {
            message,
            type: 'gateway_error',
            param: null,
            code,
          },
        }));
      } catch (_e) {}
    }

    function parseClientMessage(data: WebSocket.RawData, isBinary: boolean): any {
      if (isBinary) throw new Error('binary_not_supported');

      let messageStr: string;
      if (Buffer.isBuffer(data)) {
        messageStr = data.toString('utf-8');
      } else if (typeof data === 'string') {
        messageStr = data;
      } else if (data instanceof ArrayBuffer) {
        messageStr = Buffer.from(data).toString('utf-8');
      } else {
        messageStr = Buffer.concat(data as any).toString('utf-8');
      }

      try {
        return JSON.parse(messageStr);
      } catch {
        throw new Error('invalid_json');
      }
    }

    async function handleClientMessage(data: WebSocket.RawData, isBinary: boolean) {
      resetIdleTimer();

      let requestBody: any;
      try {
        requestBody = parseClientMessage(data, isBinary);
      } catch (err: any) {
        sendGatewayError(err.message, err.message);
        return;
      }

      if (requestBody?.type !== 'response.create') {
        sendGatewayError('Expected response.create event', 'expected_response_create');
        return;
      }

      if (inFlight) {
        sendGatewayError('A response is already in progress on this WebSocket', 'response_in_progress');
        return;
      }

      inFlight = true;
      const turnStartTime = Date.now();
      const abortController = new AbortController();
      const closeAbortHandler = () => abortController.abort();
      socket.once('close', closeAbortHandler);

      const acquireResult = await virtualKeyQueueService.acquire(virtualKeyValue, abortController.signal);
      if (!acquireResult.granted) {
        memoryLogger.warn(`${logPrefix} | Queue rejected: ${acquireResult.reason}`, 'WebSocket');
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', ...buildQueue429Error(acquireResult.reason) }));
        }
        socket.off('close', closeAbortHandler);
        inFlight = false;
        return;
      }

      try {
        const tokenUsage = await bridgeResponsesWebSocket({
          config: protocolConfig,
          requestBody,
          socket,
          abortController,
          logPrefix,
          maxDurationMs,
          closeOnTerminal: false,
        });

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
              success: true,
              statusCode: 200,
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
          tokenCount: tokenUsage,
          status: 'success',
          responseTime: duration,
          requestType: 'openai-responses-ws',
          ip: requestIp,
          userAgent: requestUserAgent,
        }).catch((_e) => {});
      } finally {
        acquireResult.release();
        socket.off('close', closeAbortHandler);
        inFlight = false;
        resetIdleTimer();
      }
    }

    resetIdleTimer();
    socket.on('message', (data, isBinary) => {
      handleClientMessage(data, isBinary).catch((err: any) => {
        memoryLogger.error(`${logPrefix} | ${err?.message || String(err)}`, 'WebSocket');
        sendGatewayError(err?.message || 'handler_error', 'handler_error');
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

    // Send error frame if socket is still open
    if (socket.readyState === WebSocket.OPEN) {
      const errorCodes: Record<string, string> = {
        idle_timeout: 'idle_timeout',
        client_disconnected: 'client_disconnected',
        binary_not_supported: 'binary_not_supported',
        invalid_json: 'invalid_json',
        expected_response_create: 'expected_response_create',
      };
      const reason = errorCodes[errorMessage] || 'handler_error';

      if (reason !== 'client_disconnected') {
        const errorPayload = {
          type: 'error',
          error: {
            message: errorMessage,
            type: 'gateway_error',
            param: null,
            code: reason,
          },
        };
        try {
          socket.send(JSON.stringify(errorPayload));
        } catch (_e) {}
      }

      try {
        socket.close(1011, reason);
      } catch (_e) {}
    }
  }
}
