import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader } from '../proxy/auth.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { isAnthropicProtocolConfig } from '../../utils/protocol-utils.js';
import type { VirtualKey } from '../../types/index.js';
import type { AnthropicRequest, AnthropicError } from '../../types/anthropic.js';
import { makeAnthropicRequest, makeAnthropicStreamRequest } from './http-client.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';

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

    try {
      // 反爬虫检测
      const { antiBotService } = await import('../../services/anti-bot.js');
      const userAgent = request.headers['user-agent'] || '';
      const ip = extractIp(request);
      const antiBotResult = antiBotService.detect(userAgent, ip);

      antiBotService.logDetection(userAgent, antiBotResult, ip, request.headers);

      if (antiBotResult.shouldBlock) {
        memoryLogger.warn(`拦截爬虫/威胁IP请求 | IP: ${ip} | UA: ${userAgent} | 原因: ${antiBotResult.reason}`, 'AntiBot');
        const anthropicError = createAnthropicError('Access denied: Bot detected', 'authentication_error');
        return reply.code(403).send(anthropicError);
      }

      // 支持从多种 header 读取虚拟密钥（兼容 Claude / SDK 风格）
      const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);

      const authResult = await authenticateVirtualKey(resolvedAuthHeader);
      if ('error' in authResult) {
        const anthropicError = createAnthropicError(
          authResult.error.body.error.message,
          authResult.error.body.error.code === 'missing_authorization' ? 'authentication_error' : 'permission_error'
        );
        return reply.code(authResult.error.code).send(anthropicError);
      }

      const { virtualKey, virtualKeyValue: vkValue } = authResult;
      virtualKeyValue = vkValue;

      const requestBody = request.body as AnthropicRequest;
      
      if (!requestBody.model) {
        const error = createAnthropicError('Missing required field: model', 'invalid_request_error');
        return reply.code(400).send(error);
      }

      // 标记协议类型为 Anthropic
      const proxyRequest: any = {
        body: requestBody,
        protocol: 'anthropic' as const
      };

      if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
        const error = createAnthropicError('Missing required field: messages', 'invalid_request_error');
        return reply.code(400).send(error);
      }

      if (!requestBody.max_tokens) {
        const error = createAnthropicError('Missing required field: max_tokens', 'invalid_request_error');
        return reply.code(400).send(error);
      }

      const modelResult = await resolveModelAndProvider(virtualKey, proxyRequest, virtualKeyValue!);
      if ('code' in modelResult) {
        const anthropicError = createAnthropicError(
          modelResult.body.error?.message || 'Model resolution failed',
          'invalid_request_error'
        );
        return reply.code(modelResult.code).send(anthropicError);
      }

      const { provider, providerId: resolvedProviderId, currentModel: resolvedModel } = modelResult;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const configResult = await buildProviderConfig(
        provider,
        virtualKey,
        virtualKeyValue!,
        providerId,
        request,
        currentModel
      );
      
      if ('code' in configResult) {
        const anthropicError = createAnthropicError(
          configResult.body.error?.message || 'Configuration failed',
          'api_error'
        );
        return reply.code(configResult.code).send(anthropicError);
      }

      const { protocolConfig, vkDisplay } = configResult;

      if (!isAnthropicProtocolConfig(protocolConfig)) {
        const error = createAnthropicError(
          'Provider does not support Anthropic protocol. Only Anthropic-compatible providers are supported for /v1/messages endpoint.',
          'invalid_request_error'
        );
        return reply.code(400).send(error);
      }

      const isStreamRequest = requestBody.stream === true;

      memoryLogger.info(
        `Anthropic 请求: ${requestBody.model} | stream: ${isStreamRequest} | virtual key: ${vkDisplay}`,
        'Anthropic'
      );

      if (isStreamRequest) {
        return await handleAnthropicStreamRequest(
          request,
          reply,
          protocolConfig,
          virtualKey,
          providerId,
          startTime,
          currentModel
        );
      }

      return await handleAnthropicNonStreamRequest(
        request,
        reply,
        protocolConfig,
        virtualKey,
        providerId,
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

          const tokenCount = await calculateTokensIfNeeded(0, requestBody);

          const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
          const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
          await logApiRequestToDb({
            virtualKey,
            providerId: providerId!,
            model: requestBody?.model || 'unknown',
            tokenCount,
            status: 'error',
            responseTime: duration,
            errorMessage: error.message,
            truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
            cacheHit: 0,
            ip,
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
  startTime: number,
  currentModel?: any
) {
  const requestBody = request.body as AnthropicRequest;
  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  try {
    const response = await makeAnthropicRequest(protocolConfig, requestBody);

    const duration = Date.now() - startTime;
    const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

    if (isSuccess) {
      circuitBreaker.recordSuccess(providerId);

      const responseData = JSON.parse(response.body);
      const shouldLogBody = shouldLogRequestBody(virtualKey);

      const tokenCount = await calculateTokensIfNeeded(0, requestBody, responseData);

      const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
      const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: requestBody.model,
        tokenCount,
        status: 'success',
        responseTime: duration,
        truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
        truncatedResponse: shouldLogBody ? JSON.stringify(responseData) : undefined,
        cacheHit: 0,
        ip,
      });

      memoryLogger.info(
        `Anthropic 请求完成: ${response.statusCode} | ${duration}ms | tokens: ${(responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0)}`,
        'Anthropic'
      );

      reply.header('Content-Type', 'application/json');
      return reply.code(response.statusCode).send(responseData);
    } else {
      circuitBreaker.recordFailure(providerId, new Error(`HTTP ${response.statusCode}`));

      const errorData = JSON.parse(response.body);
      const shouldLogBody = shouldLogRequestBody(virtualKey);

      const tokenCount = await calculateTokensIfNeeded(0, requestBody, errorData);

      const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
      const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: requestBody.model,
        tokenCount,
        status: 'error',
        responseTime: duration,
        errorMessage: JSON.stringify(errorData),
        truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
        cacheHit: 0,
        ip,
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
    circuitBreaker.recordFailure(providerId, error);

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(0, requestBody);

    const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
    const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: requestBody.model,
      tokenCount,
      status: 'error',
      responseTime: duration,
      errorMessage: error.message,
      truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
      cacheHit: 0,
      ip,
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
  startTime: number,
  currentModel?: any
) {
  const requestBody = request.body as AnthropicRequest;
  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  memoryLogger.info(
    `Anthropic 流式请求开始: ${requestBody.model} | virtual key: ${vkDisplay}`,
    'Anthropic'
  );

  try {
    const tokenUsage = await makeAnthropicStreamRequest(protocolConfig, requestBody, reply);

    const duration = Date.now() - startTime;
    circuitBreaker.recordSuccess(providerId);

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(
      tokenUsage.totalTokens,
      requestBody,
      undefined,
      undefined,
      tokenUsage.promptTokens,
      tokenUsage.completionTokens
    );

    const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
    const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: requestBody.model,
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest: shouldLogBody ? JSON.stringify(requestBody) : undefined,
      truncatedResponse: shouldLogBody ? tokenUsage.streamChunks.join('') : undefined,
      cacheHit: 0,
      ip,
    });

    memoryLogger.info(
      `Anthropic 流式请求完成: ${duration}ms | tokens: ${tokenUsage.totalTokens}`,
      'Anthropic'
    );

    return;
  } catch (streamError: any) {
    const duration = Date.now() - startTime;
    circuitBreaker.recordFailure(providerId, streamError);

    memoryLogger.error(
      `Anthropic 流式请求失败: ${streamError.message}`,
      'Anthropic',
      { error: streamError.stack }
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    const tokenCount = await calculateTokensIfNeeded(0, requestBody);

    const ipHeader = request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.ip || 'unknown';
    const ip = Array.isArray(ipHeader) ? ipHeader[0] : ipHeader;
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
      ip,
    });

    return;
  }
}
