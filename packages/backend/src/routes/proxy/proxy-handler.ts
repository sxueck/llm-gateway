import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse, buildFullRequestBody, accumulateResponsesStream, stripFieldRecursively } from '../../utils/request-logger.js';
import { messageCompressor } from '../../services/message-compressor.js';
import { extractIp } from '../../utils/ip.js';
import { manualIpBlocklist } from '../../services/manual-ip-blocklist.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { makeHttpRequest, makeStreamHttpRequest } from './http-client.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from './cache.js';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { calculateTokensIfNeeded } from './token-calculator.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { shouldLogRequestBody, getModelForLogging } from './handlers/shared.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';
import { isChatCompletionsPath, isResponsesApiPath, isEmbeddingsPath, hasV1BetaPrefix } from '../../utils/path-detector.js';
import { handleGeminiNativeNonStreamRequest, handleGeminiNativeStreamRequest } from './handlers/gemini-native.js';
import { aifwService } from '../../services/aifw-service.js';
import { restorePlaceholdersInObjectInPlace } from '../../utils/aifw-placeholders.js';

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

export function createProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;
    let compressionStats: { originalTokens: number; savedTokens: number } | undefined;
    let currentModel: any | undefined;
    let requestIp = 'unknown';
    let requestUserAgent = '';

    try {
      requestIp = extractIp(request);
      requestUserAgent = getRequestUserAgent(request);
      const manualBlock = await manualIpBlocklist.isBlocked(requestIp);
      if (manualBlock) {
        memoryLogger.warn(
          `拦截手动屏蔽 IP 请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${manualBlock.reason || '管理员拦截'}`,
          'ManualBlock'
        );
        return reply.code(403).send({
          error: {
            message: 'Access denied: IP blocked',
            type: 'access_denied',
            param: 'ip',
            code: 'ip_blocked'
          }
        });
      }

      // 反爬虫检测
      const { antiBotService } = await import('../../services/anti-bot.js');
      const antiBotResult = antiBotService.detect(requestUserAgent, requestIp);

      antiBotService.logDetection(requestUserAgent, antiBotResult, requestIp, request.headers);
      
      if (antiBotResult.shouldBlock) {
        memoryLogger.warn(`拦截爬虫/威胁IP请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${antiBotResult.reason}`, 'AntiBot');
        return reply.code(403).send({
          error: {
            message: 'Access denied: Bot detected',
            type: 'access_denied',
            param: 'user-agent',
            code: 'bot_detected'
          }
        });
      }

      // 支持从多种 header 读取虚拟密钥（兼容 Gemini / Claude 等 SDK 的 API Key 头）
      const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);

      const authResult = await authenticateVirtualKey(resolvedAuthHeader);
      if ('error' in authResult) {
        return reply.code((authResult.error as any).code).send((authResult.error as any).body);
      }

      const { virtualKey, virtualKeyValue: vkValue } = authResult;
      virtualKeyValue = vkValue;

      // 对于 Gemini 原生请求，需要提前从 URL 路径中提取模型名称并注入请求体
      // 这样 resolveModelAndProvider 才能正确匹配虚拟密钥配置的模型
      const [rawPath] = request.url.split('?');
      const normalizedPath = rawPath || '/';
      if (normalizedPath.startsWith('/v1beta/models/') && (!request.body || !(request.body as any)?.model)) {
        const pathMatch = normalizedPath.match(/\/models\/([^:\/]+)/);
        if (pathMatch && pathMatch[1]) {
          const extractedModel = pathMatch[1];
          if (request.body && typeof request.body === 'object') {
            (request.body as any).model = extractedModel;
          } else {
            request.body = { model: extractedModel };
          }
          memoryLogger.debug(
            `提前从 Gemini URL 提取模型名称: ${extractedModel}`,
            'Proxy'
          );
        }
      }

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

      const isGeminiNativeMode = protocolConfig.protocol === 'google';

      let geminiApiPath = path;
      if (isGeminiNativeMode && !hasV1BetaPrefix(path)) {
        // 如果路径不是 /v1beta/ 开头，构造标准的 Gemini API 路径
        const modelName = (request.body as any)?.model || protocolConfig.model || 'gemini-pro';
        const action = isStreamRequest ? 'streamGenerateContent' : 'generateContent';
        geminiApiPath = `/v1beta/models/${modelName}:${action}`;

        memoryLogger.info(
          `Gemini 原生模式路径转换: ${path} -> ${geminiApiPath}`,
          'Proxy'
        );
      }

      if (isGeminiNativeMode) {
        memoryLogger.info(
          `进入 Gemini 原生透传模式 | path: ${geminiApiPath} | protocol: ${protocolConfig.protocol}`,
          'Proxy'
        );

        // Gemini 原生透传：根据是否流式分别处理
        if (isStreamRequest) {
          return await handleGeminiNativeStreamRequest(
            request,
            reply,
            protocolConfig,
            geminiApiPath,
            virtualKey,
            providerId,
            startTime,
            vkDisplay,
            currentModel
          );
        } else {
          return await handleGeminiNativeNonStreamRequest(
            request,
            reply,
            protocolConfig,
            geminiApiPath,
            virtualKey,
            providerId,
            startTime,
            vkDisplay,
            currentModel
          );
        }
      }

      if (currentModel && (request.body as any)?.messages && isChatCompletionsPath(path)) {
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

      if (request.method !== 'GET' && request.method !== 'HEAD') {
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

          await logApiRequestToDb({
            virtualKey,
            providerId,
            model: getModelForLogging(request.body, currentModel),
            tokenCount,
            status: 'error',
            responseTime: duration,
            errorMessage: error.message,
            truncatedRequest,
            cacheHit: 0,
            compressionStats,
            ip: requestIp,
            userAgent: requestUserAgent,
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

  const streamRequestUserAgent = getRequestUserAgent(request);
  const streamRequestIp = extractIp(request);

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

    // OneAIFW preprocessing: mask sensitive text before sending to upstream.
    // For streams, ProtocolAdapter will restore placeholders in the stream using options.__aifw.
    const aifwCtx = await aifwService.maskRequestBodyInPlace(request.body);

    if (isResponsesApi) {
      // Responses API 请求
      const input = (request.body as any)?.input;
      // 传递提取的系统提示到 buildResponsesOptions
      const options = buildResponsesOptions((request.body as any), false, extractedSystemPrompt);

      if (aifwCtx) {
        (options as any).__aifw = aifwCtx;
        memoryLogger.debug('OneAIFW preprocessing enabled for this stream request', 'AIFW');
      }

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
      const options: any = {
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

      if (aifwCtx) {
        options.__aifw = aifwCtx;
        memoryLogger.debug('OneAIFW preprocessing enabled for this stream request', 'AIFW');
      }

      // 支持 Gemini 原生格式：如果请求体包含 contents 字段，传递给 options
      if ((request.body as any)?.contents) {
        options.contents = (request.body as any).contents;
      }
      if ((request.body as any)?.systemInstruction) {
        options.systemInstruction = (request.body as any).systemInstruction;
      }
      if ((request.body as any)?.generationConfig) {
        // 合并 generationConfig 到 options
        Object.assign(options, (request.body as any).generationConfig);
      }

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
      cachedTokens: tokenUsage.cachedTokens,
      compressionStats,
      ip: streamRequestIp,
      userAgent: streamRequestUserAgent,
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
          model: getModelForLogging(request.body, currentModel),
          durationMs: duration,
          requestBody: fullRequestBody,
          // For stream we forward raw chunks to keep all content
          responseBody: tokenUsage.streamChunks,
          requestHeaders: request.headers,
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
          vkDisplay,
          modelResult,
          currentModel,
          compressionStats,
          startTime,
          isResponsesApi,
          extractedSystemPrompt
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
      ip: streamRequestIp,
      userAgent: streamRequestUserAgent,
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
          model: getModelForLogging(request.body, currentModel),
          durationMs: duration,
          requestBody: fullRequestBody,
          error: streamError.message,
          requestHeaders: request.headers,
        });
      } catch (_e) {}
    }
 
    const errorPayload = streamError?.errorResponse || {
      error: {
        message: streamError?.message || 'Stream request failed',
        type: 'api_error',
        param: null,
        code: 'stream_error'
      }
    };

    // 若仍未发送任何响应，则返回规范化错误
    if (!reply.raw.headersSent && !reply.sent) {
      const finalStatus = statusForRetry || 500;
      reply.raw.writeHead(finalStatus, { 'Content-Type': 'application/json' });
      reply.raw.write(JSON.stringify(errorPayload));
      reply.raw.end();
    } else if (!reply.raw.writableEnded) {
      try {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`);
      } catch (_e) {}
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
  const nonStreamRequestUserAgent = getRequestUserAgent(request);
  const nonStreamRequestIp = extractIp(request);

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

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: getModelForLogging(request.body, currentModel),
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest,
      truncatedResponse,
      cacheHit: 1,
      cachedTokens: normCached.cachedTokens,
      compressionStats,
      ip: nonStreamRequestIp,
      userAgent: nonStreamRequestUserAgent,
    });

    memoryLogger.info(
      `请求完成: 200 | ${duration}ms | tokens: ${tokenCount.totalTokens} | 缓存命中`,
      'Proxy'
    );

    return reply.send(cachedResponseForClient);
  }

  let response: any;

  // OneAIFW preprocessing: only apply after cache miss so cache key is derived from the original request.
  const aifwCtx = await aifwService.maskRequestBodyInPlace(request.body);

  if (isEmbeddingsRequest) {
    // Embeddings API 请求
    const messages = (request.body as any)?.messages || [];
    const options = {
      encoding_format: (request.body as any)?.encoding_format,
      dimensions: (request.body as any)?.dimensions,
      user: (request.body as any)?.user,
    };

    if (aifwCtx) {
      (options as any).__aifw = aifwCtx;
      memoryLogger.debug('OneAIFW preprocessing enabled for this non-stream request', 'AIFW');
    }
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
    const options: any = {
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

    if (aifwCtx) {
      options.__aifw = aifwCtx;
      memoryLogger.debug('OneAIFW preprocessing enabled for this non-stream request', 'AIFW');
    }

    // 支持 Gemini 原生格式：如果请求体包含 contents 字段，传递给 options
    if ((request.body as any)?.contents) {
      options.contents = (request.body as any).contents;
    }
    if ((request.body as any)?.systemInstruction) {
      options.systemInstruction = (request.body as any).systemInstruction;
    }
    if ((request.body as any)?.generationConfig) {
      // 合并 generationConfig 到 options
      Object.assign(options, (request.body as any).generationConfig);
    }

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

    // Restore placeholders (masked by OneAIFW) back to original values for client.
    if (aifwCtx?.maskMeta) {
      try {
        await aifwService.restoreResponseBodyInPlace(responseData, aifwCtx.maskMeta);
      } catch (e: any) {
        memoryLogger.error(`OneAIFW restore failed: ${e.message}`, 'Proxy');
        // Fallback to local regex restoration if remote fails (best effort)
        if (aifwCtx.placeholdersMap) {
          try {
            restorePlaceholdersInObjectInPlace(responseData, aifwCtx.placeholdersMap);
          } catch {}
        }
      }
    } else if (aifwCtx?.placeholdersMap) {
      // Legacy fallback (shouldn't be reached if maskMeta is always present)
      try {
        restorePlaceholdersInObjectInPlace(responseData, aifwCtx.placeholdersMap);
      } catch {}
    }

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
        vkDisplay,
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
        model: getModelForLogging(request.body, currentModel),
        durationMs: duration,
        requestBody: fullRequestBody,
        responseBody: responseData,
        error: isSuccess ? undefined : JSON.stringify(responseData),
        requestHeaders: request.headers,
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

  await logApiRequestToDb({
    virtualKey,
    providerId,
    model: getModelForLogging(request.body, currentModel),
    tokenCount,
    status: isSuccess ? 'success' : 'error',
    responseTime: duration,
    errorMessage: isSuccess ? undefined : JSON.stringify(responseData),
    truncatedRequest,
    truncatedResponse,
    cacheHit: fromCache ? 1 : 0,
    cachedTokens: norm.cachedTokens,
    compressionStats,
    ip: nonStreamRequestIp,
    userAgent: nonStreamRequestUserAgent,
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
