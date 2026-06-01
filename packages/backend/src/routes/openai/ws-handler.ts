import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { virtualKeyQueueService } from '../../services/virtual-key-queue.js';
import {
  relayWebSocket,
  deriveWebSocketUrl,
  type WebSocketConnectionMetadata,
} from '../../services/websocket-proxy.js';
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

  const wsHandler = async (socket: WebSocket, request: FastifyRequest) => {
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
  socket: WebSocket,
  request: FastifyRequest,
  context: any
): Promise<void> {
  const startTime = Date.now();
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

  let release: (() => void) | undefined;

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

    const upstreamBaseUrl = protocolConfig.baseUrl;
    if (!upstreamBaseUrl) {
      memoryLogger.error(`${logPrefix} | Provider has no base URL configured`, 'WebSocket');
      socket.close(1008, 'missing_upstream_url');
      return;
    }

    const upstreamUrl = deriveWebSocketUrl(upstreamBaseUrl, path);
    const upstreamApiKey = protocolConfig.apiKey;

    if (!upstreamApiKey) {
      memoryLogger.error(`${logPrefix} | Provider has no API key configured`, 'WebSocket');
      socket.close(1008, 'missing_upstream_key');
      return;
    }

    const abortController = new AbortController();
    const acquireResult = await virtualKeyQueueService.acquire(virtualKeyValue, abortController.signal);
    if (socketClosedEarly) {
      if (acquireResult.granted) {
        acquireResult.release();
      }
      return;
    }

    if (!acquireResult.granted) {
      memoryLogger.warn(
        `${logPrefix} | Queue rejected: ${acquireResult.reason}`,
        'WebSocket'
      );
      const errorPayload = buildQueue429Error(acquireResult.reason);
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(errorPayload));
        }
      } catch (_e) {}
      socket.close(1008, 'queue_rejected');
      return;
    }

    release = acquireResult.release;

    const metadata: WebSocketConnectionMetadata = {
      virtualKeyId: virtualKey.id,
      virtualKeyName: (virtualKey as any).name,
      providerId,
      model: protocolConfig.model || 'unknown',
      upstreamBaseUrl,
      path,
      clientIp: requestIp,
      userAgent: requestUserAgent,
      startTime,
    };

    const maxDurationMs = 10 * 60 * 1000;
    const idleTimeoutMs = 5 * 60 * 1000;

    await relayWebSocket({
      upstreamUrl,
      upstreamApiKey,
      downstreamSocket: socket,
      metadata,
      onClose: (tokenUsage) => {
        const duration = Date.now() - startTime;
        release?.();

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
      },
      maxDurationMs,
      idleTimeoutMs,
    });
  } catch (err: any) {
    memoryLogger.error(`${logPrefix} | ${err.message}`, 'WebSocket');
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1011, 'handler_error');
      }
    } catch (_e) {}
    release?.();
  }
}
