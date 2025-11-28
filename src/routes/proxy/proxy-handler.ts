import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { apiRequestDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse, buildFullRequestBody, accumulateResponsesStream, stripFieldRecursively } from '../../utils/request-logger.js';
import { promptProcessor } from '../../services/prompt-processor.js';
import { messageCompressor } from '../../services/message-compressor.js';
import { makeHttpRequest, makeStreamHttpRequest } from './http-client.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from './cache.js';
import { authenticateVirtualKey } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { calculateTokensIfNeeded } from './token-calculator.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { handleChatStreamRequest } from './handlers/openai-chat.js';
import { handleResponsesStreamRequest } from './handlers/openai-responses.js';
import { shouldLogRequestBody, buildFullRequest, getTruncatedBodies, logApiRequest } from './handlers/shared.js';
import type { VirtualKey } from '../../types/index.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';
import { isChatCompletionsPath, isResponsesApiPath, isEmbeddingsPath } from '../../utils/path-detector.js';

const MESSAGE_COMPRESSION_MIN_TOKENS = parseInt(process.env.MESSAGE_COMPRESSION_MIN_TOKENS || '2048', 10);

function responsesInputNeedsNormalization(items: any[]): boolean {
  return items.some(item => {
    if (!item || typeof item !== 'object') {
      return false;
    }

    if ((item.role === 'developer' || item.role === 'system') && item.content) {
      return true;
    }

    if (item.type === 'text') {
      return true;
    }

    if (item.type === 'message' && Array.isArray(item.content)) {
      return item.content.some((block: any) => block?.type === 'text');
    }

    if (item.role && Array.isArray(item.content)) {
      return item.content.some((block: any) => block?.type === 'text');
    }

    return false;
  });
}

function estimateTokensForMessages(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  let totalChars = 0;
  for (const message of messages) {
    if (!message) continue;
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block.text === 'string') {
          totalChars += block.text.length;
        }
      }
    }
  }

  return Math.ceil(totalChars / 4);
}

function buildRequestBodyForLogging(
  requestBody: any,
  modelAttributes: any,
  shouldLogBody: boolean
) {
  if (shouldLogBody || debugModeService.isActive()) {
    return buildFullRequestBody(requestBody, modelAttributes);
  }
  return requestBody;
}
/**
 * 规范化 Responses API 的 input 并提取系统提示
 *
 * Responses API 的 input 中不应包含 system/developer 角色的消息
 * 这些应该通过顶层的 instructions 字段传递
 *
 * @param input 原始 input 数据
 * @returns { normalizedInput, systemPrompt } 规范化后的 input 和提取的系统提示
 */
function normalizeResponsesInput(input: any): { normalizedInput: any; systemPrompt?: string } {
  if (!input) return { normalizedInput: input };

  // 如果是字符串，直接返回
  if (typeof input === 'string') return { normalizedInput: input };

  // 如果是数组，递归处理每个元素
  if (Array.isArray(input)) {
    if (!responsesInputNeedsNormalization(input)) {
      return { normalizedInput: input };
    }

    const systemPrompts: string[] = [];
    const normalizedItems: any[] = [];

    for (const item of input) {
      if (!item || typeof item !== 'object') {
        normalizedItems.push(item);
        continue;
      }

      // 提取 developer/system 角色的消息作为系统提示
      if ((item.role === 'developer' || item.role === 'system') && item.content) {
        let textContent = '';
        if (typeof item.content === 'string') {
          textContent = item.content;
        } else if (Array.isArray(item.content)) {
          // 提取所有 text 类型的内容
          textContent = item.content
            .filter((block: any) => block?.type === 'text' || block?.type === 'input_text')
            .map((block: any) => block.text)
            .join('\n');
        }
        if (textContent) {
          systemPrompts.push(textContent);
        }
        // 不将 developer/system 角色的消息添加到 normalizedItems
        continue;
      }

      // 处理 message 类型的 item
      if (item.type === 'message' && Array.isArray(item.content)) {
        normalizedItems.push({
          ...item,
          content: item.content.map((contentBlock: any) => {
            if (!contentBlock || typeof contentBlock !== 'object') return contentBlock;

            // 将 type: 'text' 转换为 type: 'input_text'
            if (contentBlock.type === 'text') {
              return {
                ...contentBlock,
                type: 'input_text'
              };
            }

            return contentBlock;
          })
        });
        continue;
      }

      // 处理带有 role 和 content 数组的项（如来自 health check 的输入）
      if (item.role && Array.isArray(item.content)) {
        normalizedItems.push({
          ...item,
          content: item.content.map((contentBlock: any) => {
            if (!contentBlock || typeof contentBlock !== 'object') return contentBlock;

            // 将 type: 'text' 转换为 type: 'input_text'
            if (contentBlock.type === 'text') {
              return {
                ...contentBlock,
                type: 'input_text'
              };
            }

            return contentBlock;
          })
        });
        continue;
      }

      // 处理直接的 content block
      if (item.type === 'text') {
        normalizedItems.push({
          ...item,
          type: 'input_text'
        });
        continue;
      }

      normalizedItems.push(item);
    }

    // 合并所有提取的系统提示
    const systemPrompt = systemPrompts.length > 0 ? systemPrompts.join('\n\n') : undefined;

    return {
      normalizedInput: normalizedItems,
      systemPrompt
    };
  }

  return { normalizedInput: input };
}

/**
 * 构建 Responses API 的 options 参数
 *
 * 关键：Responses API 的 instructions 字段是系统级指令（类似 Chat Completions 的 system message）
 * 需要从 input 中提取 developer/system 角色的消息，合并到 instructions 中
 *
 * @param body 请求体
 * @param includePrevId 是否包含 previous_response_id
 * @param extractedSystemPrompt 从 input 中提取的系统提示（如果有）
 */
function buildResponsesOptions(body: any, includePrevId: boolean, extractedSystemPrompt?: string) {
  // 合并系统指令：优先使用提取的系统提示，其次使用用户提供的 instructions
  // 如果两者都存在，将它们合并（提取的系统提示在前）
  let finalInstructions: string | undefined;
  if (extractedSystemPrompt && body?.instructions) {
    finalInstructions = `${extractedSystemPrompt}\n\n${body.instructions}`;
  } else {
    finalInstructions = extractedSystemPrompt || body?.instructions;
  }

  const options: any = {
    instructions: finalInstructions,
    temperature: body?.temperature,
    max_output_tokens: body?.max_output_tokens,
    top_p: body?.top_p,
    store: body?.store,
    metadata: body?.metadata,
    tools: body?.tools,
    tool_choice: body?.tool_choice,
    parallel_tool_calls: body?.parallel_tool_calls,
    mcp: body?.mcp,
    reasoning: body?.reasoning,
    text: body?.text,
    truncation: body?.truncation,
    user: body?.user,
    include: body?.include,
  };
  if (includePrevId && body?.previous_response_id) {
    options.previous_response_id = body.previous_response_id;
  }
  return options;
}

const responsesConversationCache = new Map<string, { id: string; expire: number }>();

function getResponsesConversationId(model: string | undefined, userId: string | undefined) {
  const key = `${model || 'unknown'}-${userId || 'anonymous'}`;
  const now = Date.now();
  const existing = responsesConversationCache.get(key) as { id: string; expire: number } | undefined;

  if (existing && existing.expire > now) {
    return existing.id;
  }

  const id = nanoid();
  responsesConversationCache.set(key, { id, expire: now + 60 * 60 * 1000 });
  return id;
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

      if (currentModel && (request.body as any)?.messages && isChatCompletionsPath(path)) {
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

        const approxTokens = estimateTokensForMessages((request.body as any).messages);
        const shouldCompressMessages = approxTokens >= MESSAGE_COMPRESSION_MIN_TOKENS;

        if (virtualKey.dynamic_compression_enabled === 1 && shouldCompressMessages) {
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
        } else if (virtualKey.dynamic_compression_enabled === 1 && !shouldCompressMessages) {
          memoryLogger.debug(
            `跳过消息压缩 | 虚拟密钥: ${vkDisplay} | 估算 tokens: ${approxTokens} < 阈值 ${MESSAGE_COMPRESSION_MIN_TOKENS}`,
            'Proxy'
          );
        }
      }
      // 拦截Zero温度功能
      if (virtualKey.intercept_zero_temperature === 1 &&
          virtualKey.zero_temperature_replacement !== null &&
          (request.body as any)?.temperature === 0) {
        // 仅在替换阶段确保数值类型，避免被上游解析为字符串
        const replacement = typeof virtualKey.zero_temperature_replacement === 'number'
          ? virtualKey.zero_temperature_replacement
          : Number(String(virtualKey.zero_temperature_replacement));
        (request.body as any).temperature = replacement;
        memoryLogger.info(
          `拦截Zero温度: 将 temperature=0 替换为 ${replacement} | 虚拟密钥: ${vkDisplay}`,
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
      const isResponsesApi = isResponsesApiPath(path);

      let extractedSystemPrompt: string | undefined;
      if (isResponsesApi && (request.body as any)?.input) {
        const { normalizedInput, systemPrompt } = normalizeResponsesInput((request.body as any).input);
        (request.body as any).input = normalizedInput;
        extractedSystemPrompt = systemPrompt;

        if (extractedSystemPrompt) {
          memoryLogger.info(
            `Responses API: 从 input 中提取系统提示 (${extractedSystemPrompt.length} 字符)`,
            'Proxy'
          );
        }
      }

      // Responses API 只支持流式模式，非流式直接返回错误
      if (!isStreamRequest && isResponsesApi) {
        return reply.code(400).send({
          error: {
            message: 'Responses API only supports streaming mode',
            type: 'invalid_request_error',
            param: 'stream',
            code: 'responses_non_stream_not_supported'
          }
        });
      }

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
          isResponsesApi,
          modelResult,
          virtualKeyValue!,
          extractedSystemPrompt
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
        virtualKeyValue!
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

          const fullRequestBody = buildRequestBodyForLogging(request.body, modelAttributes, shouldLogBody);
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
  isResponsesApi: boolean = false,
  modelResult?: any,
  virtualKeyValueParam?: string,
  extractedSystemPrompt?: string
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
      // 传递提取的系统提示到 buildResponsesOptions
      const options = buildResponsesOptions((request.body as any), false, extractedSystemPrompt);

      const modelNameForSession = (request.body as any)?.model || currentModel?.name || 'unknown';
      const userIdForSession =
        (request.body as any)?.metadata?.user_id ||
        virtualKey?.id?.toString?.() ||
        virtualKey?.key_value ||
        vkDisplay;

      const conversationId = getResponsesConversationId(modelNameForSession, userIdForSession);
      const sessionId = nanoid();

      (options as any).conversationId = conversationId;
      (options as any).sessionId = sessionId;

      // 记录最终的 instructions 和 tools（用于调试）
      if (options.instructions) {
        memoryLogger.debug(
          `Responses API instructions (${options.instructions.length} 字符): ${options.instructions.substring(0, 100)}...`,
          'Proxy'
        );
      }
      if (options.tools && Array.isArray(options.tools)) {
        memoryLogger.info(
          `Responses API tools: ${options.tools.length} 个工具 - ${options.tools.map((t: any) => t.name || t.function?.name).join(', ')}`,
          'Proxy'
        );
      } else {
        memoryLogger.warn(
          `Responses API: 没有检测到 tools 参数，上游可能无法使用工具功能`,
          'Proxy'
        );
      }

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

    const fullRequestBody = buildRequestBodyForLogging(request.body, modelAttributes, shouldLogBody);
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
      cached_tokens: tokenUsage.cachedTokens,
      status: 'success',
      response_time: duration,
      error_message: undefined,
      request_body: truncatedRequest,
      response_body: truncatedResponse,
      cache_hit: 0,
      compression_original_tokens: compressionStats?.originalTokens,
      compression_saved_tokens: compressionStats?.savedTokens,
    });

    // Broadcast full, untruncated event to debug WebSocket clients when debug mode is active
    if (debugModeService.isActive()) {
      try {
        debugModeService.broadcast({
          type: 'api_request',
          id: nanoid(),
          timestamp: Date.now(),
          protocol: isResponsesApi ? 'openai-responses' : 'openai',
          method: request.method,
          path,
          stream: true,
          success: true,
          statusCode: 200,
          fromCache: false,
          virtualKeyId: virtualKey.id,
          virtualKeyName: (virtualKey as any).name,
          providerId,
          model: (request.body as any)?.model || 'unknown',
          durationMs: duration,
          requestBody: fullRequestBody,
          // For stream we forward raw chunks to keep all content
          responseBody: tokenUsage.streamChunks,
        });
      } catch (_e) {}
    }
 
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

    // 智能路由重试（在未发送任何响应的情况下）
    const statusForRetry = (streamError?.statusCode || streamError?.status || 500) as number;
    try {
      const { shouldRetrySmartRouting } = await import('./routing.js');
      if (modelResult?.canRetry && virtualKeyValueParam && shouldRetrySmartRouting(statusForRetry) && !reply.sent && !reply.raw.headersSent) {
        const { handleStreamRetry } = await import('./retry-handler.js');
        const retried = await handleStreamRetry(request, reply, statusForRetry, {
          virtualKey,
          virtualKeyValue: virtualKeyValueParam,
          modelResult,
          currentModel,
          compressionStats,
          startTime
        });
        if (retried) {
          return;
        }
      }
    } catch (_e) {
      // 忽略重试流程中的异常，继续走错误返回
    }

    // 记录失败请求
    const shouldLogBody = shouldLogRequestBody(virtualKey);

    let modelAttributes: any = undefined;
    if (currentModel?.model_attributes) {
      try {
        modelAttributes = JSON.parse(currentModel.model_attributes);
      } catch (e) {
      }
    }

    const fullRequestBody = buildRequestBodyForLogging(request.body, modelAttributes, shouldLogBody);
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

    if (debugModeService.isActive()) {
      try {
        debugModeService.broadcast({
          type: 'api_request',
          id: nanoid(),
          timestamp: Date.now(),
          protocol: isResponsesApi ? 'openai-responses' : 'openai',
          method: request.method,
          path,
          stream: true,
          success: false,
          statusCode: statusForRetry || 500,
          fromCache: false,
          virtualKeyId: virtualKey.id,
          virtualKeyName: (virtualKey as any).name,
          providerId,
          model: (request.body as any)?.model || 'unknown',
          durationMs: duration,
          requestBody: fullRequestBody,
          error: streamError.message,
        });
      } catch (_e) {}
    }
 
    // 若仍未发送任何响应，则返回规范化错误
    if (!reply.raw.headersSent && !reply.sent) {
      const errorPayload = streamError?.errorResponse || {
        error: {
          message: streamError?.message || 'Stream request failed',
          type: 'api_error',
          param: null,
          code: 'stream_error'
        }
      };
      const finalStatus = statusForRetry || 500;
      reply.raw.writeHead(finalStatus, { 'Content-Type': 'application/json' });
      reply.raw.write(JSON.stringify(errorPayload));
      reply.raw.end();
    }

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
  virtualKeyValueParam?: string
) {
  let fromCache = false;
  const isEmbeddingsRequest = isEmbeddingsPath(path);

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

    // 在返回与记录前净化缓存响应，去除上游调试 instructions 字段
    let cachedResponseForClient: any = cacheResult.cached.response;
    try {
      stripFieldRecursively(cachedResponseForClient, 'instructions');
    } catch (_e) {}

    const duration = Date.now() - startTime;
    const shouldLogBody = shouldLogRequestBody(virtualKey);

    let modelAttributes: any = undefined;
    if (currentModel?.model_attributes) {
      try {
        modelAttributes = JSON.parse(currentModel.model_attributes);
      } catch (e) {
      }
    }

    const fullRequestBody = buildRequestBodyForLogging(request.body, modelAttributes, shouldLogBody);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;
    const truncatedResponse = shouldLogBody ? truncateResponseBody(cachedResponseForClient) : undefined;

    // 使用统一归一化解析 usage，兼容 Responses 与 Chat Completions
    const normCached = normalizeUsageCounts(cacheResult.cached.response?.usage);
    const tokenCount = await calculateTokensIfNeeded(
      normCached.totalTokens,
      request.body,
      cacheResult.cached.response,
      undefined,
      normCached.promptTokens,
      normCached.completionTokens
    );

    await apiRequestDb.create({
      id: nanoid(),
      virtual_key_id: virtualKey.id,
      provider_id: providerId,
      model: (request.body as any)?.model || 'unknown',
      prompt_tokens: tokenCount.promptTokens,
      completion_tokens: tokenCount.completionTokens,
      total_tokens: tokenCount.totalTokens,
      cached_tokens: normCached.cachedTokens,
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

    return reply.send(cachedResponseForClient);
  }

  let response: any;

  if (isEmbeddingsRequest) {
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
    // 移除上游调试字段（例如 instructions）
    try {
      stripFieldRecursively(responseData, 'instructions');
    } catch (_e) {}

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

  const fullRequestBody = buildRequestBodyForLogging(request.body, modelAttributes, shouldLogBody);
  const truncatedRequest = shouldLogBody ? truncateRequestBody(fullRequestBody) : undefined;
  const truncatedResponse = shouldLogBody ? truncateResponseBody(responseData) : undefined;

  // Developer debug mode: send full event (no truncation) to WS clients
  if (debugModeService.isActive()) {
    try {
      debugModeService.broadcast({
        type: 'api_request',
        id: nanoid(),
        timestamp: Date.now(),
        protocol: 'openai',
        method: request.method,
        path,
        stream: false,
        success: isSuccess,
        statusCode: response.statusCode,
        fromCache,
        virtualKeyId: virtualKey.id,
        virtualKeyName: (virtualKey as any).name,
        providerId,
        model: (request.body as any)?.model || 'unknown',
        durationMs: duration,
        requestBody: fullRequestBody,
        responseBody: responseData,
        error: isSuccess ? undefined : JSON.stringify(responseData),
      });
    } catch (_e) {}
  }
 
  // 统一归一化解析 usage，兼容两种协议字段
  const norm = normalizeUsageCounts(responseData?.usage);
  const tokenCount = await calculateTokensIfNeeded(
    norm.totalTokens,
    request.body,
    responseData,
    undefined,
    norm.promptTokens,
    norm.completionTokens
  );

  await apiRequestDb.create({
    id: nanoid(),
    virtual_key_id: virtualKey.id,
    provider_id: providerId,
    model: (request.body as any)?.model || 'unknown',
    prompt_tokens: tokenCount.promptTokens,
    completion_tokens: tokenCount.completionTokens,
    total_tokens: tokenCount.totalTokens,
    cached_tokens: norm.cachedTokens,
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
