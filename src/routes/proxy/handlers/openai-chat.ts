import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { accumulateStreamResponse } from '../../../utils/request-logger.js';
import { makeHttpRequest, makeStreamHttpRequest } from '../http-client.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { circuitBreaker } from '../../../services/circuit-breaker.js';
import { shouldLogRequestBody, buildFullRequest, getTruncatedBodies, logApiRequest } from './shared.js';
import type { VirtualKey } from '../../../types/index.js';

export interface ChatStreamParams {
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

export interface ChatNonStreamParams {
  request: FastifyRequest;
  protocolConfig: any;
  virtualKey: VirtualKey;
  providerId: string;
  startTime: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  currentModel?: any;
  responseData: any;
}

/**
 * 处理Chat Completions流式请求
 */
export async function handleChatStreamRequest(params: ChatStreamParams): Promise<void> {
  const { request, reply, protocolConfig, path, vkDisplay, virtualKey, providerId, startTime, compressionStats, currentModel } = params;

  memoryLogger.info(
    `流式请求开始 (Chat): ${path} | virtual key: ${vkDisplay}`,
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
    const messages = (request.body as any)?.messages || [];
    const options = {
      temperature: (request.body as any)?.temperature,
      max_tokens: (request.body as any)?.max_tokens,
      max_completion_tokens: (request.body as any)?.max_completion_tokens,
      top_p: (request.body as any)?.top_p,
      frequency_penalty: (request.body as any)?.frequency_penalty,
      presence_penalty: (request.body as any)?.presence_penalty,
      stop: (request.body as any)?.stop,
      tools: (request.body as any)?.tools,
      tool_choice: (request.body as any)?.tool_choice,
      parallel_tool_calls: (request.body as any)?.parallel_tool_calls,
    };

    const tokenUsage = await makeStreamHttpRequest(
      protocolConfig,
      messages,
      options,
      reply,
      undefined,
      false,
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
      `流式请求完成 (Chat): ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'Proxy'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const { truncatedRequest, truncatedResponse } = getTruncatedBodies(
      request.body,
      shouldLogBody ? accumulateStreamResponse(tokenUsage.streamChunks) : undefined,
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
      memoryLogger.info('流式请求被客户端取消 (Chat)', 'Proxy');
      return;
    }

    circuitBreaker.recordFailure(providerId, streamError);

    memoryLogger.error(
      `流式请求失败 (Chat): ${streamError.message}`,
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
 * 处理Chat Completions非流式请求
 */
export async function handleChatNonStreamRequest(params: ChatNonStreamParams): Promise<any> {
  const { request, protocolConfig, virtualKey, providerId, startTime, compressionStats, currentModel, responseData } = params;

  const messages = (request.body as any)?.messages || [];
  const options = {
    temperature: (request.body as any)?.temperature,
    max_tokens: (request.body as any)?.max_tokens,
    max_completion_tokens: (request.body as any)?.max_completion_tokens,
    top_p: (request.body as any)?.top_p,
    frequency_penalty: (request.body as any)?.frequency_penalty,
    presence_penalty: (request.body as any)?.presence_penalty,
    stop: (request.body as any)?.stop,
    user: (request.body as any)?.user,
    tools: (request.body as any)?.tools,
    tool_choice: (request.body as any)?.tool_choice,
    parallel_tool_calls: (request.body as any)?.parallel_tool_calls,
  };

  const response = await makeHttpRequest(
    protocolConfig,
    messages,
    options,
    false
  );

  return response;
}