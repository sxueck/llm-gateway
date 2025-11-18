import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { accumulateResponsesStream } from '../../../utils/request-logger.js';
import { makeHttpRequest, makeStreamHttpRequest } from '../http-client.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { circuitBreaker } from '../../../services/circuit-breaker.js';
import { shouldLogRequestBody, buildFullRequest, getTruncatedBodies, logApiRequest } from './shared.js';
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

export interface ResponsesNonStreamParams {
  request: FastifyRequest;
  protocolConfig: any;
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
    const options = {
      instructions: (request.body as any)?.instructions,
      temperature: (request.body as any)?.temperature,
      max_output_tokens: (request.body as any)?.max_output_tokens,
      top_p: (request.body as any)?.top_p,
      store: (request.body as any)?.store,
      metadata: (request.body as any)?.metadata,
      tools: (request.body as any)?.tools,
      tool_choice: (request.body as any)?.tool_choice,
      parallel_tool_calls: (request.body as any)?.parallel_tool_calls,
      reasoning: (request.body as any)?.reasoning,
      text: (request.body as any)?.text,
      truncation: (request.body as any)?.truncation,
      user: (request.body as any)?.user,
      include: (request.body as any)?.include,
    };

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

    await logApiRequest({
      virtualKey,
      providerId,
      requestBody: request.body,
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest,
      truncatedResponse,
      cacheHit: 0,
      compressionStats,
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

    await logApiRequest({
      virtualKey,
      providerId,
      requestBody: request.body,
      tokenCount,
      status: 'error',
      responseTime: duration,
      errorMessage: streamError.message,
      truncatedRequest,
      compressionStats,
    });
  }
}

/**
 * 处理OpenAI Responses API非流式请求
 */
export async function handleResponsesNonStreamRequest(params: ResponsesNonStreamParams): Promise<any> {
  const { request, protocolConfig } = params;

  const input = (request.body as any)?.input;
  const options = {
    instructions: (request.body as any)?.instructions,
    temperature: (request.body as any)?.temperature,
    max_output_tokens: (request.body as any)?.max_output_tokens,
    top_p: (request.body as any)?.top_p,
    store: (request.body as any)?.store,
    metadata: (request.body as any)?.metadata,
    tools: (request.body as any)?.tools,
    tool_choice: (request.body as any)?.tool_choice,
    parallel_tool_calls: (request.body as any)?.parallel_tool_calls,
    reasoning: (request.body as any)?.reasoning,
    text: (request.body as any)?.text,
    previous_response_id: (request.body as any)?.previous_response_id,
    truncation: (request.body as any)?.truncation,
    user: (request.body as any)?.user,
    include: (request.body as any)?.include,
  };

  const response = await makeHttpRequest(
    protocolConfig,
    [],
    options,
    false,
    input,
    true
  );

  return response;
}