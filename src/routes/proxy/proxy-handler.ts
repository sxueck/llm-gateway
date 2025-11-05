import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { apiRequestDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse } from '../../utils/request-logger.js';
import { promptProcessor } from '../../services/prompt-processor.js';
import { makeHttpRequest, makeStreamHttpRequest } from './http-client.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from './cache.js';
import { authenticateVirtualKey } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { countStreamResponseTokens, countRequestTokens } from '../../services/token-counter.js';
import type { VirtualKey } from '../../types/index.js';

function shouldLogRequestBody(virtualKey: VirtualKey): boolean {
  return !virtualKey.disable_logging;
}

async function calculateTokensIfNeeded(
  totalTokens: number,
  requestBody: any,
  responseBody?: any,
  streamChunks?: string[],
  promptTokensFromStream?: number,
  completionTokensFromStream?: number
): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number }> {
  // 优先使用从流中解析的 usage 信息
  if (promptTokensFromStream !== undefined && completionTokensFromStream !== undefined) {
    return {
      promptTokens: promptTokensFromStream,
      completionTokens: completionTokensFromStream,
      totalTokens: promptTokensFromStream + completionTokensFromStream
    };
  }

  if (totalTokens !== 0) {
    // 尝试从响应中获取详细的 token 信息
    if (responseBody?.usage) {
      const usage = responseBody.usage;
      return {
        promptTokens: usage.prompt_tokens || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || totalTokens
      };
    }
    
    // 如果只有 total_tokens，需要 fallback 计算
    if (streamChunks) {
      return await countStreamResponseTokens(requestBody, streamChunks);
    }
    
    const calculated = await countRequestTokens(requestBody, responseBody);
    return {
      promptTokens: calculated.promptTokens,
      completionTokens: calculated.completionTokens,
      totalTokens
    };
  }

  if (streamChunks) {
    return await countStreamResponseTokens(requestBody, streamChunks);
  }

  return await countRequestTokens(requestBody, responseBody);
}

export function createProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;

    try {
      // 反爬虫检测
      const { antiBotService } = await import('../../services/anti-bot.js');
      const userAgent = request.headers['user-agent'] || '';
      const ip = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';
      const antiBotResult = antiBotService.detect(userAgent);
      
      antiBotService.logDetection(userAgent, antiBotResult, typeof ip === 'string' ? ip : 'unknown');
      
      if (antiBotResult.shouldBlock) {
        memoryLogger.warn(`拦截爬虫请求 | IP: ${ip} | UA: ${userAgent}`, 'AntiBot');
        return reply.code(403).send({
          error: {
            message: 'Access denied: Bot detected',
            type: 'access_denied',
            param: 'user-agent',
            code: 'bot_detected'
          }
        });
      }

      const authResult = await authenticateVirtualKey(request.headers.authorization);
      if ('error' in authResult) {
        return reply.code((authResult.error as any).code).send((authResult.error as any).body);
      }

      const { virtualKey, virtualKeyValue: vkValue } = authResult;
      virtualKeyValue = vkValue;

      const modelResult = await resolveModelAndProvider(virtualKey, request, virtualKeyValue!);
      if ('code' in modelResult) {
        return reply.code(modelResult.code).send(modelResult.body);
      }

      const { provider, providerId: resolvedProviderId, currentModel } = modelResult;
      providerId = resolvedProviderId;

      const configResult = await buildProviderConfig(provider, virtualKey, virtualKeyValue!, providerId, request);
      if ('code' in configResult) {
        return reply.code(configResult.code).send(configResult.body);
      }

      const { protocolConfig, path, vkDisplay, isStreamRequest } = configResult;

      if (currentModel && (request.body as any)?.messages && path.startsWith('/v1/chat/completions')) {
        const processorContext = {
          date: new Date().toISOString().split('T')[0],
          requestHeaders: request.headers,
        };

        if (currentModel.prompt_config) {
          const promptConfig = promptProcessor.parsePromptConfig(currentModel.prompt_config);

          if (promptConfig) {
            try {
              const processedMessages = promptProcessor.processMessages(
                (request.body as any).messages,
                promptConfig,
                processorContext
              );

              (request.body as any).messages = processedMessages;

              memoryLogger.info(
                `Prompt 处理完成 | 模型: ${currentModel.name} | 操作: ${promptConfig.operationType}`,
                'Proxy'
              );
            } catch (promptError: any) {
              memoryLogger.error(
                `Prompt 处理失败: ${promptError.message}`,
                'Proxy'
              );
            }
          }
        }
      }

      let requestBody: string | undefined;

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestBody = JSON.stringify(request.body);
        const truncatedBody = requestBody.length > 500
          ? `${requestBody.substring(0, 500)}... (total length: ${requestBody.length} chars)`
          : requestBody;
        memoryLogger.debug(
          `Request body: ${truncatedBody}`,
          'Proxy'
        );
      }

      memoryLogger.debug(
        `转发请求: ${request.method} ${path} | stream: ${isStreamRequest}`,
        'Proxy'
      );

      if (isStreamRequest) {
        return await handleStreamRequest(
          request,
          reply,
          protocolConfig,
          path,
          vkDisplay,
          virtualKey,
          providerId,
          startTime
        );
      }

      return await handleNonStreamRequest(
        request,
        reply,
        protocolConfig,
        virtualKey,
        providerId,
        isStreamRequest,
        path,
        startTime
      );
    } catch (error: any) {
      const duration = Date.now() - startTime;

      memoryLogger.error(
        `Proxy request failed: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      if (virtualKeyValue && providerId) {
        const { virtualKeyDb } = await import('../../db/index.js');
        const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
        if (virtualKey) {
          const shouldLogBody = shouldLogRequestBody(virtualKey);
          const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;

          const tokenCount = await calculateTokensIfNeeded(0, request.body);

          await apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: (request.body as any)?.model || 'unknown',
            prompt_tokens: tokenCount.promptTokens,
            completion_tokens: 0,
            total_tokens: tokenCount.promptTokens,
            status: 'error',
            response_time: duration,
            error_message: error.message,
            request_body: truncatedRequest,
            response_body: undefined,
          });
        }
      }

      return reply.code(500).send({
        error: {
          message: error.message || '代理请求失败',
          type: 'internal_error',
          param: null,
          code: 'proxy_error'
        }
      });
    }
  };
}

async function handleStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  path: string,
  vkDisplay: string,
  virtualKey: any,
  providerId: string,
  startTime: number
) {
  memoryLogger.info(
    `流式请求开始: ${path} | virtual key: ${vkDisplay}`,
    'Proxy'
  );

  try {
    const messages = (request.body as any)?.messages || [];
    const options = {
      temperature: (request.body as any)?.temperature,
      max_tokens: (request.body as any)?.max_tokens,
      top_p: (request.body as any)?.top_p,
      frequency_penalty: (request.body as any)?.frequency_penalty,
      presence_penalty: (request.body as any)?.presence_penalty,
      stop: (request.body as any)?.stop,
    };

    const tokenUsage = await makeStreamHttpRequest(
      protocolConfig,
      messages,
      options,
      reply
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

    memoryLogger.info(
      `流式请求完成: ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'Proxy'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;
    const truncatedResponse = shouldLogBody ? accumulateStreamResponse(tokenUsage.streamChunks) : undefined;

    await apiRequestDb.create({
      id: nanoid(),
      virtual_key_id: virtualKey.id,
      provider_id: providerId,
      model: (request.body as any)?.model || 'unknown',
      prompt_tokens: tokenCount.promptTokens,
      completion_tokens: tokenCount.completionTokens,
      total_tokens: tokenCount.totalTokens,
      status: 'success',
      response_time: duration,
      error_message: undefined,
      request_body: truncatedRequest,
      response_body: truncatedResponse,
      cache_hit: 0,
    });

    return;
  } catch (streamError: any) {
    const duration = Date.now() - startTime;
    memoryLogger.error(
      `流式请求失败: ${streamError.message}`,
      'Proxy',
      { error: streamError.stack }
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;

    const tokenCount = await calculateTokensIfNeeded(0, request.body);

    await apiRequestDb.create({
      id: nanoid(),
      virtual_key_id: virtualKey.id,
      provider_id: providerId,
      model: (request.body as any)?.model || 'unknown',
      prompt_tokens: tokenCount.promptTokens,
      completion_tokens: 0,
      total_tokens: tokenCount.promptTokens,
      status: 'error',
      response_time: duration,
      error_message: streamError.message,
      request_body: truncatedRequest,
      response_body: undefined,
    });

    throw streamError;
  }
}

async function handleNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  virtualKey: any,
  providerId: string,
  isStreamRequest: boolean,
  path: string,
  startTime: number
) {
  let fromCache = false;
  const isEmbeddingsRequest = path.startsWith('/v1/embeddings');

  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  const cacheResult = checkCache(
    virtualKey,
    isStreamRequest,
    isEmbeddingsRequest,
    request.body,
    vkDisplay
  );

  if (cacheResult.cached) {
    fromCache = true;
    reply.headers({
      ...cacheResult.cached.headers,
      'X-Cache-Status': 'HIT'
    });
    reply.code(200);

    const duration = Date.now() - startTime;
    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;
    const truncatedResponse = shouldLogBody ? truncateResponseBody(cacheResult.cached.response) : undefined;

    const usageTokens = cacheResult.cached.response?.usage?.total_tokens || 0;
    const tokenCount = await calculateTokensIfNeeded(
      usageTokens,
      request.body,
      cacheResult.cached.response
    );

    await apiRequestDb.create({
      id: nanoid(),
      virtual_key_id: virtualKey.id,
      provider_id: providerId,
      model: (request.body as any)?.model || 'unknown',
      prompt_tokens: tokenCount.promptTokens,
      completion_tokens: tokenCount.completionTokens,
      total_tokens: tokenCount.totalTokens,
      status: 'success',
      response_time: duration,
      error_message: undefined,
      request_body: truncatedRequest,
      response_body: truncatedResponse,
      cache_hit: 1,
    });

    memoryLogger.info(
      `请求完成: 200 | ${duration}ms | tokens: ${tokenCount.totalTokens} | 缓存命中`,
      'Proxy'
    );

    return reply.send(cacheResult.cached.response);
  }

  const messages = (request.body as any)?.messages || [];
  const options = {
    temperature: (request.body as any)?.temperature,
    max_tokens: (request.body as any)?.max_tokens,
    top_p: (request.body as any)?.top_p,
    frequency_penalty: (request.body as any)?.frequency_penalty,
    presence_penalty: (request.body as any)?.presence_penalty,
    stop: (request.body as any)?.stop,
    encoding_format: (request.body as any)?.encoding_format,
    dimensions: (request.body as any)?.dimensions,
    user: (request.body as any)?.user,
  };

  const input = isEmbeddingsRequest ? (request.body as any)?.input : undefined;

  const response = await makeHttpRequest(
    protocolConfig,
    messages,
    options,
    isEmbeddingsRequest,
    input
  );

  const responseHeaders: Record<string, string> = {};
  Object.entries(response.headers).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.startsWith('transfer-encoding') &&
        !lowerKey.startsWith('connection') &&
        lowerKey !== 'content-length' &&
        lowerKey !== 'content-type') {
      responseHeaders[key] = Array.isArray(value) ? value[0] : value;
    }
  });

  reply.headers(responseHeaders);
  reply.code(response.statusCode);

  let responseData: any;
  const responseText = response.body;

  const truncatedResponseText = responseText.length > 500
    ? `${responseText.substring(0, 500)}... (total length: ${responseText.length} chars)`
    : responseText;

  memoryLogger.debug(
    `Raw response body: ${truncatedResponseText}`,
    'Proxy'
  );

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const isJsonResponse = contentType.includes('application/json') || contentType.includes('json');

  if (!isJsonResponse && responseText) {
    memoryLogger.warn(
      `Upstream returned non-JSON response: Content-Type=${contentType}`,
      'Proxy'
    );
    reply.header('Content-Type', contentType || 'text/plain');
    return reply.send(responseText);
  }

  try {
    responseData = responseText ? JSON.parse(responseText) : { error: { message: 'Empty response body' } };

    const responseDataStr = JSON.stringify(responseData);
    let logMessage = '';

    if (responseDataStr.length > 1000) {
      const summary = {
        id: responseData.id,
        model: responseData.model,
        choices_count: responseData.choices?.length || 0,
        first_message_preview: responseData.choices?.[0]?.message?.content?.substring(0, 100),
        usage: responseData.usage,
        total_length: responseDataStr.length
      };
      logMessage = `Response summary: ${JSON.stringify(summary)}`;
    } else {
      logMessage = `Full response: ${responseDataStr}`;
    }

    memoryLogger.debug(logMessage, 'Proxy');
  } catch (parseError) {
    const truncatedResponse = responseText.length > 200
      ? `${responseText.substring(0, 200)}... (total length: ${responseText.length})`
      : responseText;
    memoryLogger.error(
      `JSON parse failed: ${parseError} | response: ${truncatedResponse}`,
      'Proxy'
    );
    responseData = {
      error: {
        message: 'Invalid JSON response from upstream',
        type: 'api_error',
        param: null,
        code: 'invalid_response'
      }
    };
  }

  const duration = Date.now() - startTime;
  const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

  const shouldLogBody = shouldLogRequestBody(virtualKey);
  const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;
  const truncatedResponse = shouldLogBody ? truncateResponseBody(responseData) : undefined;

  const usageTokens = responseData?.usage?.total_tokens || 0;
  const tokenCount = await calculateTokensIfNeeded(
    usageTokens,
    request.body,
    responseData
  );

  await apiRequestDb.create({
    id: nanoid(),
    virtual_key_id: virtualKey.id,
    provider_id: providerId,
    model: (request.body as any)?.model || 'unknown',
    prompt_tokens: tokenCount.promptTokens,
    completion_tokens: tokenCount.completionTokens,
    total_tokens: tokenCount.totalTokens,
    status: isSuccess ? 'success' : 'error',
    response_time: duration,
    error_message: isSuccess ? undefined : JSON.stringify(responseData),
    request_body: truncatedRequest,
    response_body: truncatedResponse,
    cache_hit: fromCache ? 1 : 0,
  });

  if (isSuccess) {
    setCacheIfNeeded(cacheResult.cacheKey, cacheResult.shouldCache, fromCache, responseData, responseHeaders);

    if (cacheResult.cacheKey && cacheResult.shouldCache && !fromCache) {
      reply.header('X-Cache-Status', 'MISS');
    }

    const cacheStatus = getCacheStatus(fromCache, cacheResult.shouldCache);
    memoryLogger.info(
      `请求完成: ${response.statusCode} | ${duration}ms | tokens: ${tokenCount.totalTokens} | ${cacheStatus}`,
      'Proxy'
    );
  } else {
    const errorStr = JSON.stringify(responseData);
    const truncatedError = errorStr.length > 500
      ? `${errorStr.substring(0, 500)}... (total length: ${errorStr.length} chars)`
      : errorStr;
    memoryLogger.error(
      `请求失败: ${response.statusCode} | ${duration}ms | error: ${truncatedError}`,
      'Proxy'
    );
  }

  reply.header('Content-Type', 'application/json');

  memoryLogger.debug(
    `Response structure sent to client: ${JSON.stringify({
      has_id: !!responseData.id,
      has_object: !!responseData.object,
      object_value: responseData.object,
      has_choices: !!responseData.choices,
      choices_length: responseData.choices?.length,
      has_message: !!responseData.choices?.[0]?.message,
      message_role: responseData.choices?.[0]?.message?.role,
      message_content_length: responseData.choices?.[0]?.message?.content?.length,
      has_reasoning_content: !!responseData.choices?.[0]?.message?.reasoning_content,
      reasoning_content_length: responseData.choices?.[0]?.message?.reasoning_content?.length,
      has_thinking_blocks: !!responseData.choices?.[0]?.message?.thinking_blocks,
      thinking_blocks_count: responseData.choices?.[0]?.message?.thinking_blocks?.length,
      has_tool_calls: !!responseData.choices?.[0]?.message?.tool_calls,
      tool_calls_length: responseData.choices?.[0]?.message?.tool_calls?.length,
      has_usage: !!responseData.usage,
      usage: responseData.usage,
    })}`,
    'Proxy'
  );

  return reply.send(responseData);
}

