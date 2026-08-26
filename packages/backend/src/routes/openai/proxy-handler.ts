import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { memoryLogger } from '../../services/logger.js';
import { debugModeService } from '../../services/debug-mode.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse, buildFullRequestBody, accumulateResponsesStream, stripFieldRecursively } from '../../utils/request-logger.js';
import { messageCompressor } from '../../services/message-compressor.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { makeHttpRequest, makeStreamHttpRequest, makeImageGenerationProxyRequest } from '../proxy/http-client.js';
import { requestHeaderForwardingService } from '../../services/request-header-forwarding.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from '../proxy/cache.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { shouldLogRequestBody, getModelForLogging } from '../proxy/handlers/shared.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';
import { isChatCompletionsPath, isResponsesApiPath, isResponsesCompactPath, isEmbeddingsPath, isImagesPath, shouldBypassGatewayCache } from '../../utils/path-detector.js';
import {
  maskRequestBodyInPlace,
  restoreResponseBodyInPlace,
} from '../../services/pii-protection-service.js';
import { maybeCompressImagesInOpenAIRequestBodyInPlace, logImageCompressionStats } from '../../services/image-compression.js';
import { capturePromptSampleAsync } from '../../services/prompt-capture-service.js';
import { applyContextNormalization } from '../../services/context-normalization/index.js';
import { clampMaxTokensFields, resolveServingLimits } from '../../utils/serving-limits.js';

const MESSAGE_COMPRESSION_MIN_TOKENS = parseInt(process.env.MESSAGE_COMPRESSION_MIN_TOKENS || '2048', 10);

function shouldApplyPiiProtection(
  path: string,
  protocolConfig: any,
  isResponsesApi: boolean,
  isEmbeddingsRequest: boolean,
  virtualKey: any
): boolean {
  // Enable PII protection for OpenAI Chat Completions and Responses API.
  // Keep Embeddings excluded.
  if (isEmbeddingsRequest) return false;
  if (!isChatCompletionsPath(path) && !isResponsesApi) return false;
  // Check virtual key setting
  if (virtualKey?.pii_protection_enabled !== 1) return false;
  // Be strict: don't guess "openai" when protocol is missing.
  return protocolConfig?.protocol === 'openai';
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

function parseModelAttributes(currentModel?: any): any | undefined {
  if (!currentModel?.model_attributes) {
    return undefined;
  }

  try {
    return JSON.parse(currentModel.model_attributes);
  } catch (e: any) {
    memoryLogger.warn(`解析模型属性失败: ${e?.message || e}`, 'Proxy');
    return undefined;
  }
}
function buildResponsesOptions(body: any, includePrevId: boolean) {
  const options: any = {
    instructions: body?.instructions,
    temperature: body?.temperature,
    top_p: body?.top_p,
    store: body?.store,
    metadata: body?.metadata,
    tools: body?.tools,
    tool_choice: body?.tool_choice,
    parallel_tool_calls: body?.parallel_tool_calls,
    stream_options: body?.stream_options,
    service_tier: body?.service_tier,
    prompt_cache_key: body?.prompt_cache_key,
    safety_identifier: body?.safety_identifier,
    mcp: body?.mcp,
    reasoning: body?.reasoning,
    thinking: body?.thinking,
    text: body?.text,
    truncation: body?.truncation,
    user: body?.user,
    include: body?.include,
    max_tool_calls: body?.max_tool_calls,
    background: body?.background,
    conversation: body?.conversation,
    context_management: body?.context_management,
  };
  if (includePrevId && body?.previous_response_id) {
    options.previous_response_id = body.previous_response_id;
  }
  return options;
}

// ─── ProxyRequestContext: aggregates shared request state ─────────────────
// Replaces the 13-14 positional parameters passed to handle{Stream,NonStream}Request.

export interface ProxyRequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  protocolConfig: any;
  path: string;
  virtualKey: any;
  providerId: string;
  startTime: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  currentModel?: any;
  modelResult?: any;
  virtualKeyValue: string;
  modelAttributes?: any;
  /** Serving completion cap enforced on this request (from model attributes), echoed to clients. */
  effectiveMaxCompletionTokens?: number;
}

// ─── Shared helpers ───────────────────────────────────────────────────────

function computeVkDisplay(virtualKey: any): string {
  const kv = virtualKey?.key_value;
  if (!kv) return '';
  return kv.length > 10 ? `${kv.slice(0, 6)}...${kv.slice(-4)}` : kv;
}

/** Build the common options object for Chat Completions (stream + non-stream).
 *  Call sites add protocol-specific extras (stream_options for stream, user for non-stream). */
function buildChatCompletionBaseOptions(body: any): any {
  return {
    temperature: body?.temperature,
    max_tokens: body?.max_tokens,
    max_completion_tokens: body?.max_completion_tokens,
    top_p: body?.top_p,
    frequency_penalty: body?.frequency_penalty,
    presence_penalty: body?.presence_penalty,
    stop: body?.stop,
    response_format: body?.response_format,
    store: body?.store,
    service_tier: body?.service_tier,
    prompt_cache_key: body?.prompt_cache_key,
    safety_identifier: body?.safety_identifier,
    reasoning_effort: body?.reasoning_effort,
    verbosity: body?.verbosity,
    thinking: body?.thinking,
    tools: body?.tools,
    tool_choice: body?.tool_choice,
    parallel_tool_calls: body?.parallel_tool_calls,
  };
}

/** Add Gemini-native fields (contents, systemInstruction, generationConfig) to options. */
function applyGeminiNativeFields(options: any, body: any): void {
  if (body?.contents) options.contents = body.contents;
  if (body?.systemInstruction) options.systemInstruction = body.systemInstruction;
  if (body?.generationConfig) Object.assign(options, body.generationConfig);
}

/** Filter upstream response headers (strip hop-by-hop + content-length/type). */
function filterResponseHeaders(
  headers: Record<string, string | string[]>,
  stripContentType = false
): Record<string, string> {
  const result: Record<string, string> = {};
  Object.entries(headers).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.startsWith('transfer-encoding') &&
        !lowerKey.startsWith('connection') &&
        lowerKey !== 'content-length' &&
        (!stripContentType || lowerKey !== 'content-type')) {
      result[key] = Array.isArray(value) ? value[0] : value;
    }
  });
  return result;
}

/** Parse a string response body into a data object, handling JSON and non-JSON. */
function parseResponseBody(
  responseBody: string,
  contentType: string
): any | { __raw: string; __send: true } {
  const isJsonResponse = contentType.includes('application/json') || contentType.includes('json');

  if (responseBody.length > 500) {
    memoryLogger.debug(
      `Raw response body: ${responseBody.substring(0, 500)}... (total length: ${responseBody.length} chars)`,
      'Proxy'
    );
  } else {
    memoryLogger.debug(`Raw response body: ${responseBody}`, 'Proxy');
  }

  if (!isJsonResponse && responseBody) {
    memoryLogger.warn(`Upstream returned non-JSON response: Content-Type=${contentType}`, 'Proxy');
    return { __raw: responseBody, __send: true };
  }

  try {
    return responseBody ? JSON.parse(responseBody) : { error: { message: 'Empty response body' } };
  } catch (parseError) {
    memoryLogger.error(`JSON parse failed: ${parseError} | response: ${responseBody.substring(0, 200)}`, 'Proxy');
    return {
      error: {
        message: 'Invalid JSON response from upstream',
        type: 'api_error',
        param: null,
        code: 'invalid_response'
      }
    };
  }
}

export function createOpenAIProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;
    let compressionStats: { originalTokens: number; savedTokens: number } | undefined;
    let currentModel: any | undefined;
    let parsedModelAttributes: any | undefined;
    let requestIp = 'unknown';
    let requestUserAgent = '';

    try {
      const pipelineResult = await runProxyPipeline(request, reply, {
        protocol: 'openai',
        handlers: {
          onManualBlock: ({ reply }) => {
            reply.code(403).send({
              error: {
                message: 'Access denied: IP blocked',
                type: 'access_denied',
                param: 'ip',
                code: 'ip_blocked'
              }
            });
          },
          onAntiBotBlock: ({ reply }) => {
            reply.code(403).send({
              error: {
                message: 'Access denied: Bot detected',
                type: 'access_denied',
                param: 'user-agent',
                code: 'bot_detected'
              }
            });
          },
          onAuthError: ({ reply, authError }) => {
            reply.code(authError.code).send(authError.body);
          },
          onModelError: ({ reply, modelError }) => {
            reply.code(modelError.code).send(modelError.body);
          },
          onProviderConfigError: ({ reply, providerConfigError }) => {
            reply.code(providerConfigError.code).send(providerConfigError.body);
          },
        },
        afterAuth: async ({ virtualKey, virtualKeyValue: vkValue }) => {
          virtualKeyValue = vkValue;

          // Best-effort: shrink base64 images early so cache key + payload are smaller.
          try {
            const vkDisplayPre = virtualKey.key_value && virtualKey.key_value.length > 10
              ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
              : virtualKey.key_value;
            const imageStats = await maybeCompressImagesInOpenAIRequestBodyInPlace(request.body, virtualKey as any);
            if (imageStats) {
              logImageCompressionStats(imageStats, { vkDisplay: vkDisplayPre, protocol: 'openai' });
            }
          } catch (e: any) {
            memoryLogger.warn(`图像压缩预处理失败(已跳过): ${e?.message || e}`, 'Proxy');
          }
          capturePromptSampleAsync(virtualKey, request, 'openai');
        }
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
        protocol: 'openai',
        request,
        body: request.body,
        providerId: resolvedProviderId,
        model: (request.body as any)?.model,
        forcedReasoningEffort: modelResult?.forcedReasoningEffort,
        virtualKey,
      });
      if (normalization.blocked) {
        return reply.code(normalization.status).send(normalization.body);
      }

      parsedModelAttributes = parseModelAttributes(currentModel);

      const { protocolConfig, path, vkDisplay, isStreamRequest } = configResult;

      // Clamp oversized max_tokens/max_completion_tokens to the model's serving cap
      // (sourced from model_attributes.max_completion_tokens) and expose the enforced
      // value back to the client, so clients no longer have to learn caps via 400s.
      const servingLimits = resolveServingLimits(parsedModelAttributes);
      const didClampMaxTokens = clampMaxTokensFields(request.body, servingLimits.maxCompletionTokens);
      if (didClampMaxTokens) {
        memoryLogger.info(
          `Request max tokens exceeded serving cap; clamped to ${servingLimits.maxCompletionTokens} | 模型: ${currentModel?.name}`,
          'Proxy'
        );
      }
      // The effective completion cap the relay enforced on this request (regardless
      // of whether a rewrite happened), echoed in responses for machine readability.
      const effectiveMaxCompletionTokens = servingLimits.maxCompletionTokens;

      if (currentModel && (request.body as any)?.messages && isChatCompletionsPath(path)) {
        const approxTokens = estimateTokensForMessages((request.body as any).messages);
        const shouldCompressMessages = approxTokens >= MESSAGE_COMPRESSION_MIN_TOKENS;

        if (virtualKey.dynamic_compression_enabled === 1 && shouldCompressMessages) {
          try {
            const { messages: compressedMessages, stats } = await messageCompressor.compressMessages(
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
      if (parsedModelAttributes) {
        try {
          const enhancedRequestBody = buildFullRequestBody(request.body, parsedModelAttributes);
          request.body = enhancedRequestBody;

          if (parsedModelAttributes.supports_prompt_caching) {
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

      const isResponsesApi = isResponsesApiPath(path);
      const isResponsesCompactRequest = isResponsesCompactPath(path);

      // Responses API 只支持流式模式，非流式直接返回错误
      if (!isStreamRequest && isResponsesApi && !isResponsesCompactRequest) {
        return reply.code(400).send({
          error: {
            message: 'Responses API only supports streaming mode',
            type: 'invalid_request_error',
            param: 'stream',
            code: 'responses_non_stream_not_supported'
          }
        });
      }

      const proxyCtx: ProxyRequestContext = {
        request,
        reply,
        protocolConfig,
        path,
        virtualKey,
        providerId: resolvedProviderId,
        startTime,
        compressionStats,
        currentModel,
        modelResult,
        virtualKeyValue: virtualKeyValue!,
        modelAttributes: parsedModelAttributes,
        effectiveMaxCompletionTokens,
      };

      if (isStreamRequest) {
        return await handleStreamRequest(proxyCtx);
      }

      return await handleNonStreamRequest(proxyCtx);
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

          const fullRequestBody = buildRequestBodyForLogging(request.body, parsedModelAttributes, shouldLogBody);
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
            piiMaskedCount: 0,
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

export async function handleStreamRequest(ctx: ProxyRequestContext) {
  const {
    request, reply, protocolConfig, path, virtualKey, providerId,
    startTime, compressionStats, currentModel, modelResult,
    virtualKeyValue: virtualKeyValueParam, modelAttributes: modelAttributesParam,
  } = ctx;

  const vkDisplay = computeVkDisplay(virtualKey);
  const isResponsesApi = isResponsesApiPath(path);
  const circuitBreakerKey = modelResult?.circuitBreakerKey || providerId;
  const modelAttributes = modelAttributesParam ?? parseModelAttributes(currentModel);
  let piiMaskedCount = 0;

  // Advertise the enforced completion cap on chat completions streams before the
  // first byte is written; headers cannot be added once SSE starts.
  // Streams are written via reply.raw.writeHead(), which skips Fastify-managed
  // headers, so set on the raw response too (writeHead merges setHeader values).
  if (!isResponsesApi && ctx.effectiveMaxCompletionTokens !== undefined) {
    const capHeader = String(ctx.effectiveMaxCompletionTokens);
    reply.header('X-Max-Completion-Tokens', capHeader);
    reply.raw.setHeader('X-Max-Completion-Tokens', capHeader);
  }

  memoryLogger.info(
    `流式请求开始: ${path} | virtual key: ${vkDisplay}`,
    'Proxy'
  );

  const streamRequestUserAgent = getRequestUserAgent(request);
  const streamRequestIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(
    request.headers as any
  );

  const abortController = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      memoryLogger.info('客户端断开连接，取消上游请求', 'Proxy');
    }
  });

  try {
    let tokenUsage: any;

    if (isResponsesApi) {
      const piiEnabled = shouldApplyPiiProtection(path, protocolConfig, true, false, virtualKey);
      const piiResult = piiEnabled
        ? maskRequestBodyInPlace(request.body, true)
        : { applied: false, context: null, maskedCount: 0 };
      piiMaskedCount = piiResult.maskedCount;
      const input = (request.body as any)?.input;

      const options = buildResponsesOptions((request.body as any), true);
      (options as any).__forwardedHeaders = forwardedHeaders;

      if (piiResult.context) {
        options.__pii = piiResult.context;
        memoryLogger.debug(
          `PII protection masked ${piiResult.maskedCount} items for Responses stream request`,
          'PII'
        );
      }

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

      const useUpstreamWebSocket = protocolConfig.upstreamTransport === 'websocket';

      if (useUpstreamWebSocket) {
        memoryLogger.info(
          `Responses API using upstream WebSocket | model: ${protocolConfig.model} | vk: ${vkDisplay}`,
          'Proxy'
        );
        const { streamResponsesViaWebSocket } = await import('../../services/responses-ws-adapter.js');
        tokenUsage = await streamResponsesViaWebSocket(
          protocolConfig,
          request.body,
          reply,
          abortController.signal
        );
      } else {
        tokenUsage = await makeStreamHttpRequest(
          protocolConfig,
          [],
          options,
          reply,
          input,
          true,
          abortController.signal
        );
      }
    } else {
      const messages = (request.body as any)?.messages || [];

      const piiEnabled = shouldApplyPiiProtection(path, protocolConfig, false, false, virtualKey);
      const piiResult = piiEnabled
        ? maskRequestBodyInPlace(request.body, true)
        : { applied: false, context: null, maskedCount: 0 };
      piiMaskedCount = piiResult.maskedCount;

      const options: any = {
        ...buildChatCompletionBaseOptions(request.body as any),
        stream_options: (request.body as any)?.stream_options,
      };

      // 模型名后缀解析的强制 reasoning_effort，覆盖客户端传入的值
      if (modelResult?.forcedReasoningEffort) {
        options.reasoning_effort = modelResult.forcedReasoningEffort;
        options.__skipErrorNormalization = true;
      }

      options.__forwardedHeaders = forwardedHeaders;

      if (piiResult.context) {
        options.__pii = piiResult.context;
        memoryLogger.debug(
          `PII protection masked ${piiResult.maskedCount} items for stream request`,
          'PII'
        );
      }

      applyGeminiNativeFields(options, request.body as any);

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

    circuitBreaker.recordSuccess(circuitBreakerKey);

    memoryLogger.info(
      `流式请求完成: ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'Proxy'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);

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
      tffbMs: tokenUsage.tffbMs,
      truncatedRequest,
      truncatedResponse,
      cacheHit: 0,
      cachedTokens: tokenUsage.cachedTokens,
      compressionStats,
      ip: streamRequestIp,
      userAgent: streamRequestUserAgent,
      piiMaskedCount,
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
      } catch (_e) {
        memoryLogger.debug(`Debug broadcast failed: ${(_e as Error)?.message || _e}`, 'Proxy');
      }
    }
 
    return;
  } catch (streamError: any) {
    const duration = Date.now() - startTime;

    if (streamError.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('流式请求被客户端取消', 'Proxy');
      return;
    }

    circuitBreaker.recordFailure(circuitBreakerKey, streamError);

    memoryLogger.error(
      `流式请求失败: ${streamError.message}`,
      'Proxy',
      { error: streamError.stack }
    );

    const statusForRetry = (streamError?.statusCode || streamError?.status || 500) as number;
    try {
      const { shouldRetrySmartRouting } = await import('../proxy/routing.js');
      if (modelResult?.canRetry && virtualKeyValueParam && shouldRetrySmartRouting(statusForRetry) && !reply.sent && !reply.raw.headersSent) {
        const { handleStreamRetry } = await import('../proxy/retry-handler.js');
        const retried = await handleStreamRetry(request, reply, statusForRetry, {
          virtualKey,
          virtualKeyValue: virtualKeyValueParam,
          vkDisplay,
          modelResult,
          currentModel,
          compressionStats,
          startTime,
          isResponsesApi,
          entrypointProtocol: 'openai'
        });
        if (retried) {
          return;
        }
      }
    } catch (retryError: any) {
      memoryLogger.debug(`Stream retry dispatch failed: ${retryError?.message || retryError}`, 'Proxy');
    }

    const shouldLogBody = shouldLogRequestBody(virtualKey);

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
      piiMaskedCount,
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
      } catch (_e) {
        memoryLogger.debug(`Debug broadcast failed: ${(_e as Error)?.message || _e}`, 'Proxy');
      }
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
      } catch (_e) {
        memoryLogger.debug(`Failed to write SSE error event: ${(_e as Error)?.message || _e}`, 'Proxy');
      }
      reply.raw.end();
    }

    return;
  }
}

export async function handleNonStreamRequest(ctx: ProxyRequestContext) {
  const {
    request, reply, protocolConfig, path, virtualKey, providerId,
    startTime, compressionStats, currentModel, modelResult,
    virtualKeyValue: virtualKeyValueParam, modelAttributes: modelAttributesParam,
  } = ctx;

  let fromCache = false;
  const modelAttributes = modelAttributesParam ?? parseModelAttributes(currentModel);
  const isEmbeddingsRequest = isEmbeddingsPath(path);
  const isResponsesCompactRequest = isResponsesCompactPath(path);
  const bypassGatewayCache = shouldBypassGatewayCache(path);
  const nonStreamRequestUserAgent = getRequestUserAgent(request);

  // Advertise the enforced completion cap (serving cap of this model) on all
  // non-stream responses, including cache hits.
  if (ctx.effectiveMaxCompletionTokens !== undefined) {
    reply.header('X-Max-Completion-Tokens', String(ctx.effectiveMaxCompletionTokens));
  }
  const nonStreamRequestIp = extractIp(request);
  const forwardedHeaders = requestHeaderForwardingService.buildForwardedHeaders(
    request.headers as any
  );

  const vkDisplay = computeVkDisplay(virtualKey);
  const virtualKeyValue = virtualKeyValueParam || virtualKey.key_value;
  const circuitBreakerKey = modelResult?.circuitBreakerKey || providerId;

  // Images API non-stream branch (bypasses cache and token counting)
  if (isImagesPath(path)) {
    const normalizedPath = path.toLowerCase();
    const isGenerations = normalizedPath.includes('/images/generations');

    if (!isGenerations) {
      return reply.code(400).send({
        error: {
          message: 'Images edits and variations are not supported in this phase. Only image generation is supported.',
          type: 'invalid_request_error',
          param: null,
          code: 'images_multipart_not_supported'
        }
      });
    }

    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return reply.code(415).send({
        error: {
          message: 'Unsupported content type for image generation. Only application/json is supported.',
          type: 'invalid_request_error',
          param: 'content-type',
          code: 'unsupported_images_content_type'
        }
      });
    }

    const abortController = new AbortController();
    request.raw.on('close', () => {
      abortController.abort();
    });

    try {
      const requestBody = { ...(request.body as any) || {} };
      if (protocolConfig.model) {
        requestBody.model = protocolConfig.model;
      }

      const response = await makeImageGenerationProxyRequest(
        protocolConfig,
        path,
        requestBody,
        forwardedHeaders,
        abortController.signal
      );

      const responseHeaders = filterResponseHeaders(response.headers);
      reply.headers(responseHeaders);
      reply.code(response.statusCode);

      const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
      const duration = Date.now() - startTime;

      if (!isSuccess) {
        circuitBreaker.recordFailure(circuitBreakerKey, new Error(`HTTP ${response.statusCode}`));
      } else {
        circuitBreaker.recordSuccess(circuitBreakerKey);
      }

      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const truncatedRequest = shouldLogBody ? truncateRequestBody(requestBody) : undefined;
      const truncatedResponse = shouldLogBody ? truncateResponseBody(response.body) : undefined;

      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: protocolConfig.model,
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: isSuccess ? 'success' : 'error',
        responseTime: duration,
        errorMessage: isSuccess ? undefined : (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)).substring(0, 500),
        truncatedRequest,
        truncatedResponse,
        cacheHit: 0,
        ip: nonStreamRequestIp,
        userAgent: nonStreamRequestUserAgent,
        piiMaskedCount: 0,
      });

      memoryLogger.info(
        `Image generation ${isSuccess ? 'complete' : 'failed'}: ${response.statusCode} | ${duration}ms | model: ${protocolConfig.model}`,
        'Proxy'
      );

      return reply.send(response.body);
    } catch (error: any) {
      const duration = Date.now() - startTime;

      if (error.name === 'AbortError' || abortController.signal.aborted) {
        memoryLogger.info('Image generation request cancelled by client', 'Proxy');
        return;
      }

      memoryLogger.error(
        `Image generation proxy failed: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const truncatedRequest = shouldLogBody ? truncateRequestBody(request.body) : undefined;

      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: protocolConfig.model,
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'error',
        responseTime: duration,
        errorMessage: error.message,
        truncatedRequest,
        cacheHit: 0,
        ip: nonStreamRequestIp,
        userAgent: nonStreamRequestUserAgent,
        piiMaskedCount: 0,
      });

      if (!reply.sent) {
        return reply.code(500).send({
          error: {
            message: error.message || 'Image generation proxy failed',
            type: 'internal_error',
            param: null,
            code: 'proxy_error'
          }
        });
      }
      return;
    }
  }

  const cacheResult = checkCache(
    virtualKey,
    false, // isStreamRequest — always false in the non-stream path
    bypassGatewayCache,
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
    } catch (_e) {
      memoryLogger.debug(`Strip cached instructions failed: ${(_e as Error)?.message || _e}`, 'Proxy');
    }

    const duration = Date.now() - startTime;
    const shouldLogBody = shouldLogRequestBody(virtualKey);

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
      piiMaskedCount: 0,
    });

    memoryLogger.info(
      `请求完成: 200 | ${duration}ms | tokens: ${tokenCount.totalTokens} | 缓存命中`,
      'Proxy'
    );

    return reply.send(cachedResponseForClient);
  }

  const abortController = new AbortController();
  request.raw.on('close', () => {
    abortController.abort();
  });
  let response: any;
  let piiResult: { applied: boolean; context: any; maskedCount: number } = { applied: false, context: null, maskedCount: 0 };

  if (isResponsesCompactRequest) {
    const piiEnabled = shouldApplyPiiProtection(path, protocolConfig, true, false, virtualKey);
    piiResult = piiEnabled
      ? maskRequestBodyInPlace(request.body, true)
      : { applied: false, context: null, maskedCount: 0 };
    const input = (request.body as any)?.input;

    const options: any = {
      ...(request.body as any),
      __forwardedHeaders: forwardedHeaders,
    };
    delete options.input;
    delete options.model;
    delete options.stream;

    if (piiResult.context) {
      options.__pii = piiResult.context;
      memoryLogger.debug(
        `PII protection masked ${piiResult.maskedCount} items for Responses compact request`,
        'PII'
      );
    }

    response = await makeHttpRequest(
      protocolConfig,
      [],
      options,
      false,
      input,
      false,
      undefined,
      true
    );

    if (piiResult.context) {
      (response as any).__piiContext = piiResult.context;
    }
  } else if (isEmbeddingsRequest) {
    const messages = (request.body as any)?.messages || [];
    const options = {
      encoding_format: (request.body as any)?.encoding_format,
      dimensions: (request.body as any)?.dimensions,
      user: (request.body as any)?.user,
    };
    (options as any).__forwardedHeaders = forwardedHeaders;
    const input = (request.body as any)?.input;

    response = await makeHttpRequest(
      protocolConfig,
      messages,
      options,
      true,
      input
    );
  } else {
    const messages = (request.body as any)?.messages || [];

    // PII protection: only apply after cache miss so cache key is derived from the original request.
    // User requirement: only apply for OpenAI Chat Completions.
    const piiEnabled = shouldApplyPiiProtection(path, protocolConfig, false, false, virtualKey);
    piiResult = piiEnabled
      ? maskRequestBodyInPlace(request.body, true)
      : { applied: false, context: null, maskedCount: 0 };

    const options: any = {
      ...buildChatCompletionBaseOptions(request.body as any),
      user: (request.body as any)?.user,
    };

    // 模型名后缀解析的强制 reasoning_effort，覆盖客户端传入的值
    if (modelResult?.forcedReasoningEffort) {
      options.reasoning_effort = modelResult.forcedReasoningEffort;
      options.__skipErrorNormalization = true;
    }

    options.__forwardedHeaders = forwardedHeaders;

    if (piiResult.context) {
      options.__pii = piiResult.context;
      memoryLogger.debug(
        `PII protection masked ${piiResult.maskedCount} items for non-stream request`,
        'PII'
      );
    }

    applyGeminiNativeFields(options, request.body as any);

    response = await makeHttpRequest(
      protocolConfig,
      messages,
      options,
      false
    );
  }

  const responseHeaders = filterResponseHeaders(response.headers, true);

  reply.headers(responseHeaders);
  reply.code(response.statusCode);

  let responseData: any;
  const responseBody = response.body;

  const contentType = String(response.headers['content-type'] || '').toLowerCase();

  if (typeof responseBody === 'string') {
    const parsed = parseResponseBody(responseBody, contentType);
    if (parsed && typeof parsed === 'object' && (parsed as any).__send === true && typeof (parsed as any).__raw === 'string') {
      reply.header('Content-Type', contentType || 'text/plain');
      return reply.send(parsed.__raw);
    }
    responseData = parsed;
  } else {
    responseData = responseBody ?? { error: { message: 'Empty response body' } };
    const rawResponseBody = JSON.stringify(responseData);
    const truncatedResponseText = rawResponseBody.length > 500
      ? `${rawResponseBody.substring(0, 500)}... (total length: ${rawResponseBody.length} chars)`
      : rawResponseBody;
    memoryLogger.debug(
      `Raw response body: ${truncatedResponseText}`,
      'Proxy'
    );
  }

  try {
    try {
      stripFieldRecursively(responseData, 'instructions');
    } catch (_e) {
      memoryLogger.debug(`Strip instructions failed: ${(_e as Error)?.message || _e}`, 'Proxy');
    }

    const piiContext = piiResult?.context || (response as any)?.__piiContext;
    if (piiContext) {
      try {
        restoreResponseBodyInPlace(responseData, piiContext);
      } catch (e: any) {
        memoryLogger.error(`PII restore failed: ${e.message}`, 'Proxy');
      }
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
  } catch (postProcessError) {
    memoryLogger.error(
      `Response post-process failed: ${postProcessError}`,
      'Proxy'
    );
  }
  const duration = Date.now() - startTime;
  const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
  if (!isSuccess && modelResult && virtualKeyValue) {
    const { shouldRetrySmartRouting } = await import('../proxy/routing.js');
    if (modelResult.canRetry && shouldRetrySmartRouting(response.statusCode)) {
      memoryLogger.info(
        `智能路由重试: 检测到失败 (${response.statusCode})，尝试下一个目标`,
        'Proxy'
      );

      const { handleNonStreamRetry } = await import('../proxy/retry-handler.js');
      const retried = await handleNonStreamRetry(request, reply, response.statusCode, {
        virtualKey,
        virtualKeyValue,
        vkDisplay,
        modelResult,
        currentModel,
        compressionStats,
        startTime,
        entrypointProtocol: 'openai'
      });

      if (retried) {
        return;
      }

      memoryLogger.warn(
        `智能路由重试失败: 没有更多可用目标`,
        'Proxy'
      );
    }
  }

  const shouldLogBody = shouldLogRequestBody(virtualKey);

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
    } catch (_e) {
      memoryLogger.debug(`Debug broadcast failed: ${(_e as Error)?.message || _e}`, 'Proxy');
    }
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
    piiMaskedCount: piiResult?.maskedCount || 0,
  });

  if (isSuccess) {
    circuitBreaker.recordSuccess(circuitBreakerKey);

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
    circuitBreaker.recordFailure(circuitBreakerKey, new Error(`HTTP ${response.statusCode}`));

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
