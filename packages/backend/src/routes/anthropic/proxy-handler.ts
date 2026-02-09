import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { isAnthropicProtocolConfig } from '../../utils/protocol-utils.js';
import type { VirtualKey } from '../../types/index.js';
import type { AnthropicRequest, AnthropicError } from '../../types/anthropic.js';
import { makeAnthropicRequest, makeAnthropicStreamRequest } from './http-client.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';
import { maybeCompressImagesInAnthropicRequestBodyInPlace, logImageCompressionStats } from '../../services/image-compression.js';
import { requestHeaderForwardingService } from '../../services/request-header-forwarding.js';

function shouldLogRequestBody(virtualKey: VirtualKey): boolean {
  return !virtualKey.disable_logging;
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

      const { protocolConfig, vkDisplay } = configResult;

      const requestBody = request.body as AnthropicRequest;

      if (!isAnthropicProtocolConfig(protocolConfig)) {
        const error = createAnthropicError(
          'Provider does not support Anthropic protocol. Only Anthropic-compatible providers are supported for /v1/messages endpoint.',
          'invalid_request_error'
        );
        return reply.code(400).send(error);
      }

      const isStreamRequest = requestBody.stream === true;

      memoryLogger.info(
        `Anthropic 请求: ${currentModel?.model_identifier || requestBody.model} | stream: ${isStreamRequest} | virtual key: ${vkDisplay}`,
        'Anthropic'
      );

      if (isStreamRequest) {
        return await handleAnthropicStreamRequest(
          request,
          reply,
          protocolConfig,
          virtualKey,
          resolvedProviderId,
          modelResult?.circuitBreakerKey || resolvedProviderId,
          startTime,
          currentModel
        );
      }

      return await handleAnthropicNonStreamRequest(
        request,
        reply,
        protocolConfig,
        virtualKey,
        resolvedProviderId,
        modelResult?.circuitBreakerKey || resolvedProviderId,
        startTime,
        currentModel
      );
    } catch (error: any) {
      const duration = Date.now() - startTime;

      memoryLogger.error(
        `Anthropic proxy request failed: ${error.message}`,
        'Anthropic',
        { error: error.stack }
      );

      if (virtualKeyValue && providerId) {
        const { virtualKeyDb } = await import('../../db/index.js');
        const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
        if (virtualKey) {
          const shouldLogBody = shouldLogRequestBody(virtualKey);
          const requestBody = request.body as AnthropicRequest;
          const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody?.model || 'unknown';

          const tokenCount = await calculateTokensIfNeeded(0, requestBody);

          await logApiRequestToDb({
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
          });
        }
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

async function handleAnthropicNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  virtualKey: any,
  providerId: string,
  circuitBreakerKey: string,
  startTime: number,
  currentModel?: any
) {
  const requestBody = request.body as AnthropicRequest;
  const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody.model;
  const requestUserAgent = getRequestUserAgent(request);
  const requestIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(request.headers as any);

  try {
    const response = await makeAnthropicRequest(protocolConfig, requestBody, forwardedHeaders);

    const duration = Date.now() - startTime;
    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

    if (isSuccess) {
      circuitBreaker.recordSuccess(circuitBreakerKey);

      const responseData = JSON.parse(response.body);
      const shouldLogBody = shouldLogRequestBody(virtualKey);

      const tokenCount = await calculateTokensIfNeeded(0, requestBody, responseData);

      await logApiRequestToDb({
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
      });

      memoryLogger.info(
        `Anthropic 请求完成: ${response.statusCode} | ${duration}ms | tokens: ${(responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0)}`,
        'Anthropic'
      );

      reply.header('Content-Type', 'application/json');
      return reply.code(response.statusCode).send(responseData);
    } else {
      circuitBreaker.recordFailure(circuitBreakerKey, new Error(`HTTP ${response.statusCode}`));

      const errorData = JSON.parse(response.body);
      const shouldLogBody = shouldLogRequestBody(virtualKey);

      const tokenCount = await calculateTokensIfNeeded(0, requestBody, errorData);

      await logApiRequestToDb({
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
      });

      memoryLogger.error(
        `Anthropic 请求失败: ${response.statusCode} | ${duration}ms`,
        'Anthropic'
      );

      reply.header('Content-Type', 'application/json');
      return reply.code(response.statusCode).send(errorData);
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    circuitBreaker.recordFailure(circuitBreakerKey, error);

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(0, requestBody);

    await logApiRequestToDb({
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
    });

    throw error;
  }
}

async function handleAnthropicStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  virtualKey: any,
  providerId: string,
  circuitBreakerKey: string,
  startTime: number,
  currentModel?: any
) {
  const requestBody = request.body as AnthropicRequest;
  const modelForLogging = currentModel?.model_identifier || currentModel?.name || requestBody.model;
  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  memoryLogger.info(
    `Anthropic 流式请求开始: ${modelForLogging} | virtual key: ${vkDisplay}`,
    'Anthropic'
  );

  const streamUserAgent = getRequestUserAgent(request);
  const streamIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(request.headers as any);

  try {
    const tokenUsage = await makeAnthropicStreamRequest(protocolConfig, requestBody, reply, forwardedHeaders);

    const duration = Date.now() - startTime;
    circuitBreaker.recordSuccess(circuitBreakerKey);

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(
      tokenUsage.totalTokens,
      requestBody,
      undefined,
      undefined,
      tokenUsage.promptTokens,
      tokenUsage.completionTokens
    );

    await logApiRequestToDb({
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

    await logApiRequestToDb({
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
    });

    return;
  }
}
