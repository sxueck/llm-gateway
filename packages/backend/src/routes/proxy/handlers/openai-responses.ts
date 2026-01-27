import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { accumulateResponsesStream } from '../../../utils/request-logger.js';
import { makeStreamHttpRequest } from '../http-client.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { circuitBreaker } from '../../../services/circuit-breaker.js';
import { shouldLogRequestBody, getTruncatedBodies, getModelForLogging, extractResponsesApiOptions } from './shared.js';
import { logApiRequestToDb } from '../../../services/api-request-logger.js';
import { extractIp } from '../../../utils/ip.js';
import { getRequestUserAgent } from '../../../utils/http.js';
import type { VirtualKey } from '../../../types/index.js';

export interface ResponsesStreamParams {
  request: FastifyRequest;
  reply: FastifyReply;
  protocolConfig: any;
  path: string;
  vkDisplay: string;
  virtualKey: VirtualKey;
  providerId: string;
  startTime: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  currentModel?: any;
}


/**
 * 处理OpenAI Responses API流式请求
 */
export async function handleResponsesStreamRequest(params: ResponsesStreamParams): Promise<void> {
  const { request, reply, protocolConfig, path, vkDisplay, virtualKey, providerId, startTime, compressionStats, currentModel } = params;

  memoryLogger.info(
    `流式请求开始 (Responses): ${path} | virtual key: ${vkDisplay}`,
    'Proxy'
  );

  const requestUserAgent = getRequestUserAgent(request);
  const requestIp = extractIp(request);

  // 创建 AbortController 用于取消请求
  const abortController = new AbortController();
  
  // 监听客户端断开连接
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      memoryLogger.info('客户端断开连接，取消上游请求', 'Proxy');
    }
  });

  try {
    const input = (request.body as any)?.input;
    const options = extractResponsesApiOptions(request.body);

    const tokenUsage = await makeStreamHttpRequest(
      protocolConfig,
      [],
      options,
      reply,
      input,
      true,
      abortController.signal
    );

    const duration = Date.now() - startTime;

    const tokenCount = await calculateTokensIfNeeded(
      tokenUsage.totalTokens,
      request.body,
      undefined,
      tokenUsage.streamChunks,
      tokenUsage.promptTokens,
      tokenUsage.completionTokens
    );

    circuitBreaker.recordSuccess(providerId);

    memoryLogger.info(
      `流式请求完成 (Responses): ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'Proxy'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const { truncatedRequest, truncatedResponse } = getTruncatedBodies(
      request.body,
      shouldLogBody ? accumulateResponsesStream(tokenUsage.streamChunks) : undefined,
      virtualKey,
      currentModel
    );

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: getModelForLogging(request.body, currentModel),
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest,
      truncatedResponse,
      cacheHit: 0,
      compressionStats,
      ip: requestIp,
      userAgent: requestUserAgent,
    });

  } catch (streamError: any) {
    const duration = Date.now() - startTime;

    // 检查是否是用户取消
    if (streamError.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('流式请求被客户端取消 (Responses)', 'Proxy');
      return;
    }

    circuitBreaker.recordFailure(providerId, streamError);

    memoryLogger.error(
      `流式请求失败 (Responses): ${streamError.message}`,
      'Proxy',
      { error: streamError.stack }
    );

    const { truncatedRequest } = getTruncatedBodies(
      request.body,
      undefined,
      virtualKey,
      currentModel
    );

    const tokenCount = await calculateTokensIfNeeded(0, request.body);

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: getModelForLogging(request.body, currentModel),
      tokenCount,
      status: 'error',
      responseTime: duration,
      errorMessage: streamError.message,
      truncatedRequest,
      cacheHit: 0,
      compressionStats,
      ip: requestIp,
      userAgent: requestUserAgent,
    });
  }
}
