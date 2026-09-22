import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { shouldRetrySmartRouting } from '../proxy/routing.js';
import { cloneSmartRoutingRetryBody } from '../proxy/retry-handler.js';
import { isAnthropicProtocolConfig } from '../../utils/protocol-utils.js';
import type { VirtualKey } from '../../types/index.js';
import type { AnthropicRequest, AnthropicError } from '../../types/anthropic.js';
import { makeAnthropicRequest, makeAnthropicStreamRequest } from './http-client.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';
import { maybeCompressImagesInAnthropicRequestBodyInPlace, logImageCompressionStats } from '../../services/image-compression.js';
import { requestHeaderForwardingService } from '../../services/request-header-forwarding.js';
import {
  maskRequestBodyInPlace,
  restoreResponseBodyInPlace,
} from '../../services/pii-protection-service.js';
import { capturePromptSampleAsync } from '../../services/prompt-capture-service.js';
import { applyContextNormalization } from '../../services/context-normalization/index.js';
import { clampMaxTokensFields, resolveServingLimits } from '../../utils/serving-limits.js';
import { applyDisableThinking } from '../../utils/thinking-control.js';
import { parseModelAttributes } from '../proxy/model-handlers.js';

function shouldLogRequestBody(virtualKey: VirtualKey): boolean {
  return !virtualKey.disable_logging;
}

/**
 * Defensively parse an upstream (non-stream) response body.
 *
 * Upstreams occasionally return plain-text/HTML bodies (interceptor pages,
 * gateway error pages). A raw JSON.parse would throw here, converting the
 * upstream status into a 500 and double-recording a circuit-breaker failure
 * (recordFailure before the parse + recordFailure in the catch). Instead, fall
 * back to a synthetic Anthropic error envelope so the upstream status passes
 * through with a single breaker verdict.
 */
export function parseAnthropicUpstreamBody(body: string | undefined | null): { data: any; parseFailed: boolean } {
  if (typeof body === 'string') {
    try {
      return { data: JSON.parse(body), parseFailed: false };
    } catch {
      // fall through to the fallback envelope below
    }
  }

  return {
    data: {
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Upstream returned a non-JSON response',
      },
    },
    parseFailed: true,
  };
}

function createAnthropicError(message: string, type: string = 'invalid_request_error'): AnthropicError {
  return {
    type: 'error',
    error: {
      type: type as any,
      message,
    },
  };
}

/** Aggregated request state for the Anthropic stream/non-stream handlers. */
export interface AnthropicProxyRequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  protocolConfig: any;
  virtualKey: any;
  providerId: string;
  /** Smart-routing circuit key (modelResult.circuitBreakerKey), not the bare provider id. */
  circuitBreakerKey: string;
  startTime: number;
  currentModel?: any;
  modelResult?: any;
  virtualKeyValue?: string;
  vkDisplay?: string;
  /**
   * Pristine, globally-normalized request body captured before target-specific
   * mutations (serving-cap clamp, model attributes, PII masking). Threaded
   * through RetryContext so every smart-routing retry replays the same body.
   */
  retryBodySnapshot?: any;
}

/**
 * Apply target-specific request mutations derived from the resolved (real)
 * model: serving-cap clamp on max_tokens plus disable_thinking, and advertise
 * the enforced cap. Used by both the initial dispatch and smart-routing
 * retries so a retried target receives the same transformation semantics as a
 * first attempt. Mutates request.body in place.
 */
export function applyAnthropicTargetModelMutations(request: FastifyRequest, reply: FastifyReply, currentModel?: any): any {
  const modelAttributes = parseModelAttributes(currentModel?.model_attributes);
  const servingLimits = resolveServingLimits(modelAttributes);
  const requestBody = request.body as AnthropicRequest;

  const requestedMaxTokens = requestBody.max_tokens;
  if (clampMaxTokensFields(requestBody, servingLimits.maxCompletionTokens)) {
    memoryLogger.info(
      `max_tokens ${requestedMaxTokens} exceeds serving cap, clamped to ${servingLimits.maxCompletionTokens} | 模型: ${currentModel?.name}`,
      'Anthropic'
    );
  }
  if (servingLimits.maxCompletionTokens !== undefined) {
    // Streams are written via reply.raw.writeHead(), which skips Fastify-managed
    // headers; setHeader on the raw response survives both stream and non-stream sends.
    reply.header('X-Max-Completion-Tokens', String(servingLimits.maxCompletionTokens));
    reply.raw.setHeader('X-Max-Completion-Tokens', String(servingLimits.maxCompletionTokens));
  } else {
    reply.removeHeader('X-Max-Completion-Tokens');
    reply.raw.removeHeader('X-Max-Completion-Tokens');
  }

  if (modelAttributes?.disable_thinking && applyDisableThinking(requestBody, 'anthropic')) {
    memoryLogger.info(`已禁用思考 (disable_thinking) | 模型: ${currentModel?.name}`, 'Anthropic');
  }

  return modelAttributes;
}

export interface AnthropicDispatchArgs {
  request: FastifyRequest;
  reply: FastifyReply;
  virtualKey: any;
  virtualKeyValue?: string;
  providerId: string;
  currentModel?: any;
  modelResult?: any;
  startTime: number;
  protocolConfig: any;
  vkDisplay: string;
  retryBodySnapshot?: any;
}

/**
 * Anthropic-protocol dispatch: applies this target's model mutations, then
 * routes to the Anthropic stream/non-stream handlers. Used by the initial
 * request AND by protocol-correct smart-routing retries — retries re-enter
 * here with the retry target's config, never through another protocol's
 * handlers.
 */
export async function dispatchAnthropicRequest(args: AnthropicDispatchArgs): Promise<void> {
  const {
    request,
    reply,
    virtualKey,
    providerId,
    currentModel,
    modelResult,
    startTime,
    protocolConfig,
    vkDisplay,
    virtualKeyValue,
    retryBodySnapshot,
  } = args;

  applyAnthropicTargetModelMutations(request, reply, currentModel);

  if (!isAnthropicProtocolConfig(protocolConfig)) {
    const error = createAnthropicError(
      'Provider does not support Anthropic protocol. Only Anthropic-compatible providers are supported for /v1/messages endpoint.',
      'invalid_request_error'
    );
    reply.code(400).send(error);
    return;
  }

  const isStreamRequest = (request.body as AnthropicRequest)?.stream === true;

  memoryLogger.info(
    `Anthropic 请求: ${currentModel?.model_identifier || (request.body as AnthropicRequest)?.model} | stream: ${isStreamRequest} | virtual key: ${vkDisplay}`,
    'Anthropic'
  );

  const ctx: AnthropicProxyRequestContext = {
    request,
    reply,
    protocolConfig,
    virtualKey,
    providerId,
    circuitBreakerKey: modelResult?.circuitBreakerKey || providerId,
    startTime,
    currentModel,
    modelResult,
    virtualKeyValue,
    vkDisplay,
    retryBodySnapshot,
  };

  if (isStreamRequest) {
    return await handleAnthropicStreamRequest(ctx);
  }

  return await handleAnthropicNonStreamRequest(ctx);
}

export function createAnthropicProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;
    let currentModel: any | undefined;
    let requestIp = 'unknown';
    let requestUserAgent = '';

    try {
      const pipelineResult = await runProxyPipeline(request, reply, {
        protocol: 'anthropic',
        handlers: {
          onManualBlock: ({ reply }) => {
            const anthropicError = createAnthropicError('Access denied: IP blocked', 'authentication_error');
            reply.code(403).send(anthropicError);
          },
          onAntiBotBlock: ({ reply }) => {
            const anthropicError = createAnthropicError('Access denied: Bot detected', 'authentication_error');
            reply.code(403).send(anthropicError);
          },
          onAuthError: ({ reply, authError }) => {
            const anthropicError = createAnthropicError(
              authError.body.error.message,
              authError.body.error.code === 'missing_authorization' ? 'authentication_error' : 'permission_error'
            );
            reply.code(authError.code).send(anthropicError);
          },
          onModelError: ({ reply, modelError }) => {
            const anthropicError = createAnthropicError(
              modelError.body.error?.message || 'Model resolution failed',
              'invalid_request_error'
            );
            reply.code(modelError.code).send(anthropicError);
          },
          onProviderConfigError: ({ reply, providerConfigError }) => {
            const anthropicError = createAnthropicError(
              providerConfigError.body.error?.message || 'Configuration failed',
              'api_error'
            );
            reply.code(providerConfigError.code).send(anthropicError);
          },
        },
        afterAuth: async ({ virtualKey, virtualKeyValue: vkValue }) => {
          virtualKeyValue = vkValue;
          const requestBody = request.body as AnthropicRequest;

          // Best-effort: shrink base64 images early (payload + downstream prompt caching stability).
          try {
            const vkDisplayPre = virtualKey.key_value && virtualKey.key_value.length > 10
              ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
              : virtualKey.key_value;
            const imageStats = await maybeCompressImagesInAnthropicRequestBodyInPlace(requestBody as any, virtualKey as any);
            if (imageStats) {
              logImageCompressionStats(imageStats, { vkDisplay: vkDisplayPre, protocol: 'anthropic' });
            }
          } catch (e: any) {
            memoryLogger.warn(`图像压缩预处理失败(已跳过): ${e?.message || e}`, 'Anthropic');
          }

          if (!requestBody?.model) {
            const error = createAnthropicError('Missing required field: model', 'invalid_request_error');
            reply.code(400).send(error);
            return false;
          }

          if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
            const error = createAnthropicError('Missing required field: messages', 'invalid_request_error');
            reply.code(400).send(error);
            return false;
          }

          if (!requestBody.max_tokens) {
            const error = createAnthropicError('Missing required field: max_tokens', 'invalid_request_error');
            reply.code(400).send(error);
            return false;
          }

          capturePromptSampleAsync(virtualKey, request, 'anthropic');
          return true;
        },
      });

      if (!pipelineResult.ok) {
        return;
      }

      const {
        requestIp: pipelineIp,
        requestUserAgent: pipelineUa,
        virtualKey,
        virtualKeyValue: vkValue,
        providerId: resolvedProviderId,
        currentModel: resolvedModel,
        modelResult,
        configResult,
      } = pipelineResult.context;

      requestIp = pipelineIp;
      requestUserAgent = pipelineUa;
      virtualKeyValue = vkValue;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const normalization = await applyContextNormalization({
        protocol: 'anthropic',
        request,
        body: request.body,
        providerId: resolvedProviderId,
        model: (request.body as any)?.model,
        virtualKey,
      });
      if (normalization.blocked) {
        return reply.code(normalization.status).send(normalization.body);
      }

      const { protocolConfig, vkDisplay } = configResult;

      // Smart-routing retry safety: snapshot the globally-normalized body (context
      // normalization, image compression) BEFORE any target-specific mutation
      // (serving-cap clamp, disable_thinking, per-target PII masking in the
      // handlers) so a retry to the next target replays a pristine request
      // instead of the failed target's residue.
      const retryBodySnapshot = cloneSmartRoutingRetryBody(request.body);

      return await dispatchAnthropicRequest({
        request,
        reply,
        virtualKey,
        virtualKeyValue: vkValue,
        providerId: resolvedProviderId,
        currentModel,
        modelResult,
        startTime,
        protocolConfig,
        vkDisplay,
        retryBodySnapshot,
      });
    } catch (error: any) {
      const duration = Date.now() - startTime;

      memoryLogger.error(
        `Anthropic proxy request failed: ${error.message}`,
        'Anthropic',
        { error: error.stack }
      );

      // Best-effort audit of the failed request. Fire-and-forget and fully guarded:
      // an audit/logging outage must never change the response delivered to the client.
      try {
        if (virtualKeyValue && providerId) {
          const { virtualKeyDb } = await import('../../db/index.js');
          const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
          if (virtualKey) {
            const shouldLogBody = shouldLogRequestBody(virtualKey);
            const requestBody = request.body as AnthropicRequest;
            const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody?.model || 'unknown';

            const tokenCount = await calculateTokensIfNeeded(0, requestBody);

            logApiRequestAsync({
              virtualKey,
              providerId,
              model: modelForLogging,
              tokenCount,
              status: 'error',
              responseTime: duration,
              errorMessage: error.message,
              truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
              cacheHit: 0,
              ip: requestIp,
              userAgent: requestUserAgent,
              piiMaskedCount: 0,
            });
          }
        }
      } catch (auditError: any) {
        memoryLogger.warn(`失败请求审计记录异常(已忽略): ${auditError?.message || auditError}`, 'Anthropic');
      }

      if (!reply.sent) {
        const anthropicError = createAnthropicError(
          error.message || 'Internal server error',
          'api_error'
        );
        return reply.code(500).send(anthropicError);
      }
    }
  };
}

export async function handleAnthropicNonStreamRequest(ctx: AnthropicProxyRequestContext) {
  const {
    request,
    reply,
    protocolConfig,
    virtualKey,
    providerId,
    circuitBreakerKey,
    startTime,
    currentModel,
    modelResult,
    virtualKeyValue,
    vkDisplay,
    retryBodySnapshot,
  } = ctx;

  const requestBody = request.body as AnthropicRequest;
  const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody.model;
  const requestUserAgent = getRequestUserAgent(request);
  const requestIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(request.headers as any);

  // PII protection: mask request before sending to upstream
  const piiEnabled = virtualKey?.pii_protection_enabled === 1;
  const piiResult = piiEnabled
    ? maskRequestBodyInPlace(requestBody, true)
    : { applied: false, context: null, maskedCount: 0 };

  if (piiResult.context) {
    memoryLogger.debug(
      `PII protection masked ${piiResult.maskedCount} items for Anthropic non-stream request`,
      'PII'
    );
  }

  const abortController = new AbortController();
  request.raw.on('close', () => {
    abortController.abort();
  });

  try {
    const response = await makeAnthropicRequest(protocolConfig, requestBody, forwardedHeaders, abortController.signal);

    const duration = Date.now() - startTime;
    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

    if (isSuccess) {
      circuitBreaker.recordSuccess(circuitBreakerKey);

      const parsedUpstreamBody = parseAnthropicUpstreamBody(response.body);
      if (parsedUpstreamBody.parseFailed) {
        // 2xx with a non-JSON payload (e.g., HTML interceptor page): pass the raw
        // payload and upstream status through instead of failing into a 500.
        memoryLogger.error(`Anthropic 上游返回非 JSON 响应体 (HTTP ${response.statusCode})，已原样透传`, 'Anthropic');

        const shouldLogBody = shouldLogRequestBody(virtualKey);
        logApiRequestAsync({
          virtualKey,
          providerId,
          model: modelForLogging,
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: 'error',
          responseTime: duration,
          errorMessage: `Non-JSON upstream response (HTTP ${response.statusCode})`,
          truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
          truncatedResponse: shouldLogBody ? String(response.body).substring(0, 500) : undefined,
          cacheHit: 0,
          ip: requestIp,
          userAgent: requestUserAgent,
          piiMaskedCount: piiResult.maskedCount,
        });

        const upstreamContentType = String((response.headers as any)?.['content-type'] || 'text/plain');
        reply.header('Content-Type', upstreamContentType);
        return reply.code(response.statusCode).send(response.body);
      }

      const responseData = parsedUpstreamBody.data;

      // PII protection: restore original values before sending to client
      if (piiResult.context) {
        try {
          restoreResponseBodyInPlace(responseData, piiResult.context);
        } catch (e: any) {
          memoryLogger.error(`PII restore failed: ${e.message}`, 'Anthropic');
        }
      }

      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const tokenCount = await calculateTokensIfNeeded(0, requestBody, responseData);

      logApiRequestAsync({
        virtualKey,
        providerId,
        model: modelForLogging,
        tokenCount,
        status: 'success',
        responseTime: duration,
        truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
        truncatedResponse: shouldLogBody ? JSON.stringify(responseData) : undefined,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
        piiMaskedCount: piiResult.maskedCount,
      });

      memoryLogger.info(
        `Anthropic 请求完成: ${response.statusCode} | ${duration}ms | tokens: ${(responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0)}`,
        'Anthropic'
      );

      reply.header('Content-Type', 'application/json');
      return reply.code(response.statusCode).send(responseData);
    } else {
      circuitBreaker.recordFailure(circuitBreakerKey, new Error(`HTTP ${response.statusCode}`));

      const parsedUpstreamBody = parseAnthropicUpstreamBody(response.body);
      if (parsedUpstreamBody.parseFailed) {
        memoryLogger.error(`Anthropic 上游错误响应为非 JSON (HTTP ${response.statusCode})，已返回规范化错误`, 'Anthropic');
      }
      const errorData = parsedUpstreamBody.data;
      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const tokenCount = await calculateTokensIfNeeded(0, requestBody, errorData);

      // The failed target is accounted and audited up front, BEFORE any retry
      // dispatch, so its breaker failure and audit row exist even when the
      // retry succeeds. The audit is fire-and-forget: an observability outage
      // cannot change the outcome.
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: modelForLogging,
        tokenCount,
        status: 'error',
        responseTime: duration,
        errorMessage: JSON.stringify(errorData),
        truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
        piiMaskedCount: piiResult.maskedCount,
      });

      memoryLogger.error(
        `Anthropic 请求失败: ${response.statusCode} | ${duration}ms`,
        'Anthropic'
      );

      // Smart-routing retry (OpenAI parity): switch to the next target while the
      // response is still unsent. The retry re-enters the Anthropic handlers with
      // a pristine body snapshot, never another protocol's handlers.
      if (modelResult?.canRetry && virtualKeyValue && shouldRetrySmartRouting(response.statusCode) && !reply.sent) {
        try {
          const { handleNonStreamRetry } = await import('../proxy/retry-handler.js');
          const retried = await handleNonStreamRetry(request, reply, response.statusCode, {
            virtualKey,
            virtualKeyValue,
            vkDisplay: vkDisplay || modelForLogging,
            modelResult,
            currentModel,
            startTime,
            entrypointProtocol: 'anthropic',
            retryBodySnapshot,
          });
          if (retried) {
            return;
          }
          memoryLogger.warn(`智能路由重试失败: 没有更多可用目标`, 'Anthropic');
        } catch (retryError: any) {
          memoryLogger.warn(`智能路由重试分发异常(已忽略): ${retryError?.message || retryError}`, 'Anthropic');
        }
      }

      reply.header('Content-Type', 'application/json');
      return reply.code(response.statusCode).send(errorData);
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    circuitBreaker.recordFailure(circuitBreakerKey, error);

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(0, requestBody);

    logApiRequestAsync({
      virtualKey,
      providerId,
      model: modelForLogging,
      tokenCount,
      status: 'error',
      responseTime: duration,
      errorMessage: error.message,
      truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
      cacheHit: 0,
      ip: requestIp,
      userAgent: requestUserAgent,
      piiMaskedCount: piiResult.maskedCount,
    });

    throw error;
  }
}

async function handleAnthropicStreamRequest(ctx: AnthropicProxyRequestContext) {
  const {
    request,
    reply,
    protocolConfig,
    virtualKey,
    providerId,
    circuitBreakerKey,
    startTime,
    currentModel,
    modelResult,
    virtualKeyValue,
    vkDisplay,
    retryBodySnapshot,
  } = ctx;

  const requestBody = request.body as AnthropicRequest;
  const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody.model;
  const vkDisplayResolved = vkDisplay || (virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value);

  memoryLogger.info(
    `Anthropic 流式请求开始: ${modelForLogging} | virtual key: ${vkDisplayResolved}`,
    'Anthropic'
  );

  const streamUserAgent = getRequestUserAgent(request);
  const streamIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(request.headers as any);

  // PII protection: mask request before sending to upstream
  const piiEnabled = virtualKey?.pii_protection_enabled === 1;
  const piiResult = piiEnabled
    ? maskRequestBodyInPlace(requestBody, true)
    : { applied: false, context: null, maskedCount: 0 };

  if (piiResult.context) {
    memoryLogger.debug(
      `PII protection masked ${piiResult.maskedCount} items for Anthropic stream request`,
      'PII'
    );
  }

  const abortController = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const tokenUsage = await makeAnthropicStreamRequest(
      protocolConfig,
      requestBody,
      reply,
      forwardedHeaders,
      piiResult.context,
      abortController.signal
    );

    const duration = Date.now() - startTime;
    circuitBreaker.recordSuccess(circuitBreakerKey);

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const tokenCount = await calculateTokensIfNeeded(
      tokenUsage.totalTokens,
      requestBody,
      undefined,
      tokenUsage.streamChunks,
      tokenUsage.promptTokens,
      tokenUsage.completionTokens
    );

    logApiRequestAsync({
      virtualKey,
      providerId,
      model: modelForLogging,
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
      truncatedResponse: shouldLogBody ? tokenUsage.streamChunks.join('') : undefined,
      cacheHit: 0,
      ip: streamIp,
      userAgent: streamUserAgent,
      piiMaskedCount: piiResult.maskedCount,
    });

    memoryLogger.info(
      `Anthropic 流式请求完成: ${duration}ms | tokens: ${tokenUsage.totalTokens}`,
      'Anthropic'
    );
    return;
  } catch (streamError: any) {
    const duration = Date.now() - startTime;
    circuitBreaker.recordFailure(circuitBreakerKey, streamError);

    memoryLogger.error(
      `Anthropic 流式请求失败: ${streamError.message}`,
      'Anthropic',
      { error: streamError.stack }
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(0, requestBody);

    // Account/audit the failed target before any retry dispatch; the audit is
    // fire-and-forget so an observability outage cannot change the outcome.
    logApiRequestAsync({
      virtualKey,
      providerId,
      model: requestBody.model,
      tokenCount,
      status: 'error',
      responseTime: duration,
      errorMessage: streamError.message,
      truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
      cacheHit: 0,
      ip: streamIp,
      userAgent: streamUserAgent,
      piiMaskedCount: piiResult.maskedCount,
    });

    const statusForRetry = (streamError?.statusCode || streamError?.status || 500) as number;

    // Smart-routing retry is only safe while nothing has been written to the
    // client (no SSE headers, response not ended). The transport no longer
    // writes error responses itself, so this decision belongs here.
    if (modelResult?.canRetry && virtualKeyValue && shouldRetrySmartRouting(statusForRetry) && !reply.sent && !reply.raw.headersSent && !reply.raw.writableEnded) {
      try {
        const { handleStreamRetry } = await import('../proxy/retry-handler.js');
        const retried = await handleStreamRetry(request, reply, statusForRetry, {
          virtualKey,
          virtualKeyValue,
          vkDisplay: vkDisplayResolved,
          modelResult,
          currentModel,
          startTime,
          entrypointProtocol: 'anthropic',
          retryBodySnapshot,
        });
        if (retried) {
          return;
        }
        memoryLogger.warn(`智能路由重试(流式)失败: 没有更多可用目标`, 'Anthropic');
      } catch (retryError: any) {
        memoryLogger.warn(`智能路由重试(流式)分发异常(已忽略): ${retryError?.message || retryError}`, 'Anthropic');
      }
    }

    // Terminal error delivery. Wire format is identical to the previous
    // in-transport write: status line + `data:` error payload when nothing was
    // sent yet, `event: error` SSE frame when the stream already started.
    if (streamError?.name === 'EmptyOutputError') {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      return;
    }

    const errorResponse = streamError?.errorResponse || {
      type: 'error',
      error: {
        type: 'api_error',
        message: streamError?.message || 'Stream request failed',
      },
    };

    if (!reply.raw.headersSent) {
      reply.raw.writeHead(statusForRetry, { 'Content-Type': 'application/json' });
      const errorData = `data: ${JSON.stringify(errorResponse)}\n\n`;
      reply.raw.write(errorData);
      reply.raw.end();
    } else if (!reply.raw.writableEnded) {
      const errorData = `event: error\ndata: ${JSON.stringify(errorResponse)}\n\n`;
      reply.raw.write(errorData);
      reply.raw.end();
    }
    return;
  }
}
