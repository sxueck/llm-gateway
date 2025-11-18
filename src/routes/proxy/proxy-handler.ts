import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { apiRequestDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse, buildFullRequestBody, accumulateResponsesStream } from '../../utils/request-logger.js';
import { promptProcessor } from '../../services/prompt-processor.js';
import { messageCompressor } from '../../services/message-compressor.js';
import { makeHttpRequest, makeStreamHttpRequest } from './http-client.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from './cache.js';
import { authenticateVirtualKey } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { countStreamResponseTokens, countRequestTokens } from '../../services/token-counter.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
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

  // 优先使用响应中的 usage 信息（即使 totalTokens 为 0）
  if (responseBody?.usage) {
    const usage: any = responseBody.usage;

    // 归一化 OpenAI Responses 与 Chat Completions 的用量字段
    const promptTokensBase = (usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completionTokens = (usage.completion_tokens ?? usage.output_tokens ?? 0);
    const computedTotal =
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : (promptTokensBase + completionTokens);
    // Anthropic 缓存用量字段（可能存在）
    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;

    // OpenAI Responses 缓存细节字段（通常 input_tokens 已包含 cached_tokens，这里仅在基础为 0 时兜底）
    const openaiCached =
      typeof usage?.input_tokens_details?.cached_tokens === 'number'
        ? usage.input_tokens_details.cached_tokens
        : (typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
          ? usage.prompt_tokens_details.cached_tokens
          : 0);

    // 仅在基础为 0 的情况下合并缓存，避免潜在的重复计数
    const promptTokens = promptTokensBase === 0
      ? (promptTokensBase + cacheCreation + cacheRead + openaiCached)
      : promptTokensBase;

    return { promptTokens, completionTokens, totalTokens: computedTotal };
  }

  if (totalTokens !== 0) {
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
    let compressionStats: { originalTokens: number; savedTokens: number } | undefined;
    let currentModel: any | undefined;

    try {
      // 反爬虫检测
      const { antiBotService } = await import('../../services/anti-bot.js');
      const userAgent = request.headers['user-agent'] || '';
      const ip = request.ip || request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || 'unknown';
      const antiBotResult = antiBotService.detect(userAgent);
      
      antiBotService.logDetection(userAgent, antiBotResult, typeof ip === 'string' ? ip : 'unknown', request.headers);
      
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

      const { provider, providerId: resolvedProviderId, currentModel: resolvedModel } = modelResult;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const configResult = await buildProviderConfig(provider, virtualKey, virtualKeyValue!, providerId, request, currentModel);
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

        if (virtualKey.dynamic_compression_enabled === 1) {
          try {
            const { messages: compressedMessages, stats } = messageCompressor.compressMessages(
              (request.body as any).messages
            );

            (request.body as any).messages = compressedMessages;

            compressionStats = {
              originalTokens: stats.originalTokenEstimate,
              savedTokens: stats.originalTokenEstimate - stats.compressedTokenEstimate
            };

            memoryLogger.info(
              `消息压缩完成 | 虚拟密钥: ${vkDisplay} | 压缩率: ${(stats.compressionRatio * 100).toFixed(1)}% | ` +
              `Token 节省: ${compressionStats.savedTokens}`,
              'Proxy'
            );
          } catch (compressionError: any) {
            memoryLogger.error(
              `消息压缩失败: ${compressionError.message}`,
              'Proxy'
            );
          }
        }
      }
      // 拦截Zero温度功能
      if (virtualKey.intercept_zero_temperature === 1 &&
          virtualKey.zero_temperature_replacement !== null &&
          (request.body as any)?.temperature === 0) {
        (request.body as any).temperature = virtualKey.zero_temperature_replacement;
        memoryLogger.info(
          `拦截Zero温度: 将 temperature=0 替换为 ${virtualKey.zero_temperature_replacement} | 虚拟密钥: ${vkDisplay}`,
          'Proxy'
        );
      }

      // 应用模型属性到请求体
      if (currentModel?.model_attributes) {
        try {
          const modelAttributes = JSON.parse(currentModel.model_attributes);
          const enhancedRequestBody = buildFullRequestBody(request.body, modelAttributes);
          request.body = enhancedRequestBody;

          if (modelAttributes.supports_prompt_caching) {
            const messageCount = (request.body as any)?.messages?.length || 0;
            const toolsCount = (request.body as any)?.tools?.length || 0;

            memoryLogger.info(
              `Prompt Caching 已启用 | 模型: ${currentModel.name} | ` +
              `消息数: ${messageCount} | 工具数: ${toolsCount}`,
              'Proxy'
            );
          }
        } catch (e: any) {
          memoryLogger.error(
            `应用模型属性失败: ${e.message}`,
            'Proxy'
          );
        }
      }

      let requestBody: string | undefined;

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestBody = JSON.stringify(request.body);
        const truncatedBody = truncateRequestBody(request.body);
        memoryLogger.debug(
          `Request body: ${truncatedBody}`,
          'Proxy'
        );
      }

      memoryLogger.debug(
        `转发请求: ${request.method} ${path} | stream: ${isStreamRequest}`,
        'Proxy'
      );

      // 检测是否为 Responses API 请求
      const isResponsesApi = path.startsWith('/v1/responses');

      if (isStreamRequest) {
        return await handleStreamRequest(
          request,
          reply,
          protocolConfig,
          path,
          vkDisplay,
          virtualKey,
          providerId,
          startTime,
          compressionStats,
          currentModel,
          isResponsesApi
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
        startTime,
        compressionStats,
        currentModel,
        modelResult,
        virtualKeyValue!,
        isResponsesApi
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

          let modelAttributes: any = undefined;
          if (currentModel?.model_attributes) {
            try {
              modelAttributes = JSON.parse(currentModel.model_attributes);
            } catch (e) {
            }
          }

          const fullRequestBody = buildFullRequestBody(request.body, modelAttributes);
          const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;

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
            compression_original_tokens: compressionStats?.originalTokens,
            compression_saved_tokens: compressionStats?.savedTokens,
          });
        }
      }

      // 检查是否已经发送响应(流式请求会直接写入 raw 响应)
      if (!reply.sent) {
        return reply.code(500).send({
          error: {
            message: error.message || '代理请求失败',
            type: 'internal_error',
            param: null,
            code: 'proxy_error'
          }
        });
      }
    }
  };
}

export async function handleStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  path: string,
  vkDisplay: string,
  virtualKey: any,
  providerId: string,
  startTime: number,
  compressionStats?: { originalTokens: number; savedTokens: number },
  currentModel?: any,
  isResponsesApi: boolean = false
) {
  memoryLogger.info(
    `流式请求开始: ${path} | virtual key: ${vkDisplay}`,
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
    let tokenUsage: any;

    if (isResponsesApi) {
      // Responses API 请求
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

      tokenUsage = await makeStreamHttpRequest(
        protocolConfig,
        [],
        options,
        reply,
        input,
        true,
        abortController.signal
      );
    } else {
      // Chat Completions API 请求
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

      tokenUsage = await makeStreamHttpRequest(
        protocolConfig,
        messages,
        options,
        reply,
        undefined,
        false,
        abortController.signal
      );
    }

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
      `流式请求完成: ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'Proxy'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);

    let modelAttributes: any = undefined;
    if (currentModel?.model_attributes) {
      try {
        modelAttributes = JSON.parse(currentModel.model_attributes);
      } catch (e) {
      }
    }

    const fullRequestBody = buildFullRequestBody(request.body, modelAttributes);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;
    const truncatedResponse = shouldLogBody
      ? (isResponsesApi ? accumulateResponsesStream(tokenUsage.streamChunks) : accumulateStreamResponse(tokenUsage.streamChunks))
      : undefined;

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
      compression_original_tokens: compressionStats?.originalTokens,
      compression_saved_tokens: compressionStats?.savedTokens,
    });

    return;
  } catch (streamError: any) {
    const duration = Date.now() - startTime;

    // 检查是否是用户取消
    if (streamError.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('流式请求被客户端取消', 'Proxy');
      // 不记录为失败，因为这是正常的取消操作
      return;
    }

    circuitBreaker.recordFailure(providerId, streamError);

    memoryLogger.error(
      `流式请求失败: ${streamError.message}`,
      'Proxy',
      { error: streamError.stack }
    );


    const shouldLogBody = shouldLogRequestBody(virtualKey);

    let modelAttributes: any = undefined;
    if (currentModel?.model_attributes) {
      try {
        modelAttributes = JSON.parse(currentModel.model_attributes);
      } catch (e) {
      }
    }

    const fullRequestBody = buildFullRequestBody(request.body, modelAttributes);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;

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
      compression_original_tokens: compressionStats?.originalTokens,
      compression_saved_tokens: compressionStats?.savedTokens,
    });

    // 流式请求失败时，如果响应已经发送，则不再处理
    // http-client 会处理错误响应的发送
    return;
  }
}

export async function handleNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: any,
  virtualKey: any,
  providerId: string,
  isStreamRequest: boolean,
  path: string,
  startTime: number,
  compressionStats?: { originalTokens: number; savedTokens: number },
  currentModel?: any,
  modelResult?: any,
  virtualKeyValueParam?: string,
  isResponsesApi: boolean = false
) {
  let fromCache = false;
  const isEmbeddingsRequest = path.startsWith('/v1/embeddings');

  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  const virtualKeyValue = virtualKeyValueParam || virtualKey.key_value;

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

    let modelAttributes: any = undefined;
    if (currentModel?.model_attributes) {
      try {
        modelAttributes = JSON.parse(currentModel.model_attributes);
      } catch (e) {
      }
    }

    const fullRequestBody = buildFullRequestBody(request.body, modelAttributes);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;
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
      compression_original_tokens: compressionStats?.originalTokens,
      compression_saved_tokens: compressionStats?.savedTokens,
    });

    memoryLogger.info(
      `请求完成: 200 | ${duration}ms | tokens: ${tokenCount.totalTokens} | 缓存命中`,
      'Proxy'
    );

    return reply.send(cacheResult.cached.response);
  }

  let response: any;

  if (isResponsesApi) {
    // Responses API 请求
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

    response = await makeHttpRequest(
      protocolConfig,
      [],
      options,
      false,
      input,
      true
    );
  } else if (isEmbeddingsRequest) {
    // Embeddings API 请求
    const messages = (request.body as any)?.messages || [];
    const options = {
      encoding_format: (request.body as any)?.encoding_format,
      dimensions: (request.body as any)?.dimensions,
      user: (request.body as any)?.user,
    };
    const input = (request.body as any)?.input;

    response = await makeHttpRequest(
      protocolConfig,
      messages,
      options,
      true,
      input
    );
  } else {
    // Chat Completions API 请求
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

    response = await makeHttpRequest(
      protocolConfig,
      messages,
      options,
      false
    );
  }

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

  // 智能路由重试逻辑
  if (!isSuccess && modelResult && virtualKeyValue) {
    const { shouldRetrySmartRouting } = await import('./routing.js');
    if (modelResult.canRetry && shouldRetrySmartRouting(response.statusCode)) {
      memoryLogger.info(
        `智能路由重试: 检测到失败 (${response.statusCode})，尝试下一个目标`,
        'Proxy'
      );

      const { handleNonStreamRetry } = await import('./retry-handler.js');
      const retried = await handleNonStreamRetry(request, reply, response.statusCode, {
        virtualKey,
        virtualKeyValue,
        modelResult,
        currentModel,
        compressionStats,
        startTime
      });

      if (retried) {
        // 重试成功，已经发送新的响应，直接返回
        return;
      }

      // 重试失败，继续发送原始错误响应
      memoryLogger.warn(
        `智能路由重试失败: 没有更多可用目标`,
        'Proxy'
      );
    }
  }

  const shouldLogBody = shouldLogRequestBody(virtualKey);

  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch (e) {
    }
  }

  const fullRequestBody = buildFullRequestBody(request.body, modelAttributes);
  const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;
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
    compression_original_tokens: compressionStats?.originalTokens,
    compression_saved_tokens: compressionStats?.savedTokens,
  });

  if (isSuccess) {
    circuitBreaker.recordSuccess(providerId);

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
    circuitBreaker.recordFailure(providerId, new Error(`HTTP ${response.statusCode}`));

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

