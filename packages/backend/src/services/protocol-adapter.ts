import OpenAI from 'openai';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';
import { PiiStreamRestorer } from './pii-protection-service.js';
import { HttpClientFactory } from './http-client-factory.js';
import { processOpenAIChatCompletionStreamToSse } from '../utils/stream-processor.js';
import { withStreamIdleTimeout } from '../utils/stream-guards.js';
import {
  DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES,
  processOpenAIResponsesStreamToSseWithRetry,
} from '../utils/responses-stream-processor.js';
import { filterForwardedHeaders } from '../utils/header-sanitizer.js';
import { buildResumeMessages, isStreamResumeEnabled } from './stream-resumer.js';

export type UpstreamTransport = 'http_sse' | 'websocket';

export interface ProtocolConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  nativeBaseUrl?: string;
  model: string;
  /**
   * Model name to report to the client in chunk `model` fields (PRD §4 B
   * layer). Set only for exposure.model_field=gateway_name; absent keeps
   * the upstream identifier byte-identical.
   */
  clientModel?: string;
  /** §4C debug comment line for SSE streams (opt-in, exposure.sse_comment). */
  sseComment?: string;
  protocol?: string;
  modelAttributes?: any;
  /** Preferred upstream transport for Responses API streaming.
   *  Defaults to 'http_sse' when absent. */
  upstreamTransport?: UpstreamTransport;
}

export interface ProtocolResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning_content?: string;
      thinking_blocks?: ThinkingBlock[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}


/** Client-caused validation failure: status 400 keeps it out of the circuit
 *  breaker and maps it to invalid_request_error downstream. */
function invalidRequestError(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

const CHAT_PASSTHROUGH_KEYS = [
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'n',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'user',
  'seed',
  'metadata',
  'store',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'response_format',
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_retention',
  'reasoning_effort',
  'verbosity',
  'modalities',
  'audio',
  'prediction',
  'web_search_options',
  'thinking',
  'enable_thinking',
  'tool_search',
  'phase',
] as const;

const RESPONSES_PASSTHROUGH_KEYS = [
  'instructions',
  'background',
  'conversation',
  'context_management',
  'temperature',
  'top_p',
  'store',
  'metadata',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream_options',
  'service_tier',
  'mcp',
  'reasoning',
  'thinking',
  'text',
  'max_output_tokens',
  'max_tool_calls',
  'truncation',
  'user',
  'include',
  'prompt',
  'prompt_cache_key',
  'prompt_cache_retention',
  'safety_identifier',
  'tool_search',
  'phase',
] as const;

export function assignResponsesRequestParams(
  target: any,
  source: any,
  includePreviousResponseId: boolean
): void {
  if (!source) return;
  for (const key of RESPONSES_PASSTHROUGH_KEYS) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  if (includePreviousResponseId && source.previous_response_id !== undefined) {
    target.previous_response_id = source.previous_response_id;
  }
}

function assignChatCompletionParams(requestParams: any, options: any): void {
  for (const key of CHAT_PASSTHROUGH_KEYS) {
    if (options[key] !== undefined) requestParams[key] = options[key];
  }
  // Forward the token cap exactly as the client sent it: renaming
  // max_completion_tokens to max_tokens is rejected by OpenAI reasoning
  // models (o-series / gpt-5), which only accept max_completion_tokens.
  if (options.max_completion_tokens !== undefined) {
    requestParams.max_completion_tokens = options.max_completion_tokens;
  } else if (options.max_tokens !== undefined) {
    requestParams.max_tokens = options.max_tokens;
  }
}

export function applyReasoningEffortNoneTranslation(
  requestParams: any,
  options: any
): void {
  if ((options as any)?.reasoning_effort !== 'none') return;
  if (requestParams.thinking !== undefined) return;

  requestParams.thinking = { type: 'disabled' };
  delete requestParams.reasoning_effort;

  memoryLogger.debug('reasoning_effort=none -> thinking.type=disabled', 'Protocol');
}

export class ProtocolAdapter {
  private readonly httpClientFactory = new HttpClientFactory({
    keepAliveMaxSockets: parseInt(process.env.HTTP_KEEP_ALIVE_MAX_SOCKETS || '64', 10),
    logger: memoryLogger as any,
  });

  /**
   * Build per-request forwarded headers for upstream calls.
   * Important: do NOT allow client-forwarded headers to override modelAttributes.headers.
   */
  private getForwardedHeaders(config: ProtocolConfig, options: any): Record<string, string> | undefined {
    return filterForwardedHeaders(config.modelAttributes?.headers, (options as any)?.__forwardedHeaders);
  }

  /** The SDK's own timeout stops at the response headers, so streams get a separate idle bound. */
  private resolveStreamIdleTimeoutMs(config: ProtocolConfig, options: any): number {
    const configured = config.modelAttributes?.timeout;
    const perRequest = options?.requestTimeout ?? config.modelAttributes?.requestTimeout;
    const base = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : 300_000;
    return typeof perRequest === 'number' && Number.isFinite(perRequest) ? Math.max(base, perRequest) : base;
  }

  private applyForwardedHeadersToRequestOptions(requestOptions: any, config: ProtocolConfig, options: any): void {
    const forwardedHeaders = this.getForwardedHeaders(config, options);
    if (!forwardedHeaders) return;

    requestOptions.headers = {
      ...forwardedHeaders,
      ...(requestOptions.headers || {}),
    };
  }

  private isThinkingEnabled(options: any): boolean {
    const thinking = options?.thinking;
    if (thinking === true) return true;
    if (!thinking || typeof thinking !== 'object') return false;
    if ((thinking as any).enabled === true) return true;
    if ((thinking as any).type === 'enabled') return true;
    return false;
  }

  private ensureReasoningContentForToolCalls(messages: any[], options: any): any[] {
    if (!this.isThinkingEnabled(options)) return messages;
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'assistant') continue;
      if (!Array.isArray((msg as any).tool_calls) || (msg as any).tool_calls.length === 0) continue;
      if ((msg as any).reasoning_content === undefined || (msg as any).reasoning_content === null) {
        (msg as any).reasoning_content = '';
      }
    }
    return messages;
  }

  private getOpenAIClient(config: ProtocolConfig): OpenAI {
    // Kept as a private method so tests can monkey-patch it.
    // The actual client/agent caching now lives in HttpClientFactory.
    return this.httpClientFactory.getOpenAIClient(config);
  }

  private validateAndCleanMessages(messages: any[], options?: any): any[] {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw invalidRequestError('messages 数组不能为空');
    }

    const cleanedMessages = messages.filter(msg => {
      if (!msg || typeof msg !== 'object') {
        return false;
      }

      if (msg.role === 'tool') {
        return msg.tool_call_id && typeof msg.content === 'string';
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return true;
      }

      const content = msg.content;

      if (typeof content === 'string') {
        return content.trim().length > 0;
      }

      if (Array.isArray(content)) {
        return content.some(part => {
          if (part.type === 'text' && part.text) {
            return part.text.trim().length > 0;
          }
          return part.type === 'image_url' || part.type === 'image';
        });
      }

      return false;
    });

    if (cleanedMessages.length === 0) {
      throw invalidRequestError('过滤后的 messages 数组为空，所有消息内容均为空白');
    }

    return this.ensureReasoningContentForToolCalls(cleanedMessages, options);
  }

  async chatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<ProtocolResponse> {
    memoryLogger.debug(
      `直接转发请求 | model: ${config.model} | protocol: ${config.protocol || 'openai'}`,
      'Protocol'
    );

    return await this.openaiChatCompletion(config, messages, options, abortSignal);
  }

  private async openaiChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<ProtocolResponse> {
    const client = this.getOpenAIClient(config);

    const cleanedMessages = this.validateAndCleanMessages(messages, options);

    const requestParams: any = {
      model: config.model,
      messages: cleanedMessages,
      stream: false,
    };

    assignChatCompletionParams(requestParams, options);
    applyReasoningEffortNoneTranslation(requestParams, options);

    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const response = await client.chat.completions.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    );

    return response as any;
  }

  async streamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply,
    abortSignal?: AbortSignal
  ): Promise<StreamTokenUsage> {
    memoryLogger.debug(
      `直接转发流式请求 | model: ${config.model} | protocol: ${config.protocol || 'openai'}`,
      'Protocol'
    );

    return await this.openaiStreamChatCompletion(config, messages, options, reply, abortSignal);
  }

  private async openaiStreamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply,
    abortSignal?: AbortSignal
  ): Promise<StreamTokenUsage> {
    const client = this.getOpenAIClient(config);

    // Chat stream path only uses builtin PII protection (no legacy AIFW fallback)
    const piiCtx = (options as any)?.__pii;
    const streamRestorer = piiCtx ? new PiiStreamRestorer(piiCtx) : null;

    const cleanedMessages = this.validateAndCleanMessages(messages, options);

    const requestParams: any = {
      model: config.model,
      messages: cleanedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    assignChatCompletionParams(requestParams, options);
    if ((options as any).stream_options !== undefined) {
      // stream_options is only valid for stream=true; usage stays on for accounting.
      requestParams.stream_options = { ...(options as any).stream_options, include_usage: true };
    }
    applyReasoningEffortNoneTranslation(requestParams, options);

    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const streamIdleTimeoutMs = this.resolveStreamIdleTimeoutMs(config, options);

    // Stream resume (system setting `stream_resume_enabled`): on a mid-stream
    // upstream failure the processor asks this factory for a continuation
    // stream built from the text already delivered downstream.
    const resumeStreamFactory = async (
      partialText: string
    ): Promise<AsyncIterable<any> | null> => {
      if (!(await isStreamResumeEnabled())) return null;
      try {
        return withStreamIdleTimeout(
          await client.chat.completions.create(
            {
              ...requestParams,
              messages: buildResumeMessages(cleanedMessages, partialText),
            },
            Object.keys(requestOptions).length > 0 ? requestOptions : undefined
          ) as unknown as AsyncIterable<any>,
          streamIdleTimeoutMs
        );
      } catch (resumeError: any) {
        memoryLogger.debug(`断点续传请求创建失败: ${resumeError?.message || resumeError}`, 'Protocol');
        return null;
      }
    };

    const upstreamRequestStartedAt = Date.now();
    // SAFETY: OpenAI SDK returns a Stream<ChatCompletionChunk>-like async iterable in
    // streaming mode; its generated union type doesn't narrow here, but every consumer
    // iterates SSE chunk objects.
    const stream = withStreamIdleTimeout(
      await client.chat.completions.create(
        requestParams,
        Object.keys(requestOptions).length > 0 ? requestOptions : undefined
      ) as unknown as AsyncIterable<any>,
      streamIdleTimeoutMs
    );
    return await processOpenAIChatCompletionStreamToSse({
      reply,
      stream,
      model: config.model,
      clientModel: config.clientModel,
      sseComment: config.sseComment,
      abortSignal,
      upstreamRequestStartedAt,
      streamRestorer,
      skipUsageChunks: (options as any)?.stream_options?.include_usage !== true,
      logger: memoryLogger,
      resumeStreamFactory,
    });
  }

  async createEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any = {},
    abortSignal?: AbortSignal
  ): Promise<any> {
    memoryLogger.debug(
      `直接转发 Embeddings 请求 | model: ${config.model} | protocol: ${config.protocol || 'openai'}`,
      'Protocol'
    );

    return await this.openaiCreateEmbedding(config, input, options, abortSignal);
  }

  private async openaiCreateEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    const client = this.getOpenAIClient(config);

    const requestParams: any = {
      model: config.model,
      input,
    };

    if (options.encoding_format !== undefined) {
      requestParams.encoding_format = options.encoding_format;
    }

    if (options.dimensions !== undefined) {
      requestParams.dimensions = options.dimensions;
    }

    if (options.user !== undefined) {
      requestParams.user = options.user;
    }

    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const response = await client.embeddings.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    );

    return response;
  }

  private buildResponsesRequestParams(options: any, includePreviousResponseId: boolean): any {
    const params: any = {};
    assignResponsesRequestParams(params, options, includePreviousResponseId);
    return params;
  }

  async compactResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    memoryLogger.debug(
      `使用 Responses API compact | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiCompactResponse(config, input, options, abortSignal);
  }

  async createResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    memoryLogger.debug(
      `使用 Responses API | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiCreateResponse(config, input, options, abortSignal);
  }

  private async openaiCreateResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    const client = this.getOpenAIClient(config);

    const requestParams: any = {
      model: config.model,
      input,
      stream: false,
    };

    Object.assign(requestParams, this.buildResponsesRequestParams(options, true));

    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const response = await client.responses.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    );

    return response;
  }

  private async openaiCompactResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    const client = this.getOpenAIClient(config);

    const requestParams: any = {
      model: config.model,
      input,
    };

    Object.assign(requestParams, this.buildResponsesRequestParams(options, false));

    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const compactFn = (client.responses as any)?.compact;
    if (typeof compactFn !== 'function') {
      throw new Error('Current OpenAI SDK does not support responses.compact');
    }

    return await compactFn.call(
      client.responses,
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    );
  }

  async streamResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    reply: FastifyReply,
    abortSignal?: AbortSignal
  ): Promise<StreamTokenUsage> {
    memoryLogger.debug(
      `使用 Responses API 流式请求 | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiStreamResponse(config, input, options, reply, abortSignal);
  }

  private async openaiStreamResponse(
    config: ProtocolConfig,
    input: string | any[],
    options: any,
    reply: FastifyReply,
    abortSignal?: AbortSignal
  ): Promise<StreamTokenUsage> {
    const client = this.getOpenAIClient(config);
    // Responses API stream uses the same builtin PII protection as chat completions
    const piiCtx = (options as any)?.__pii;
    const streamRestorer = piiCtx ? new PiiStreamRestorer(piiCtx) : null;

    const requestParams: any = {
      model: config.model,
      input,
      stream: true,
    };

    // 添加 Responses API 支持的参数（允许 previous_response_id 以支持多轮衔接）
    Object.assign(requestParams, this.buildResponsesRequestParams(options, true));

    const requestOptions: any = {};
    const requestTimeoutMs =
      options.requestTimeout !== undefined
        ? options.requestTimeout
        : config.modelAttributes?.requestTimeout;
    if (requestTimeoutMs !== undefined) {
      requestOptions.timeout = requestTimeoutMs;
    }

    // 为 Responses API 附加会话相关头，便于上游识别会话
    const extraHeaders: Record<string, string> = {};
    if ((options as any).conversationId) {
      extraHeaders['Conversation-Id'] = String((options as any).conversationId);
    }
    if ((options as any).sessionId) {
      extraHeaders['Session-Id'] = String((options as any).sessionId);
    }
    if (Object.keys(extraHeaders).length > 0) {
      requestOptions.headers = {
        ...(requestOptions.headers || {}),
        ...extraHeaders,
      };
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    };
    if ((options as any).conversationId) {
      responseHeaders['X-Conversation-Id'] = String((options as any).conversationId);
    }
    if ((options as any).sessionId) {
      responseHeaders['X-Session-Id'] = String((options as any).sessionId);
    }

    const modelRetryLimit = typeof config.modelAttributes?.responses_empty_retry_limit === 'number'
      ? Math.max(0, Math.floor(config.modelAttributes.responses_empty_retry_limit))
      : DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES;
    const totalAttempts = Math.max(1, modelRetryLimit + 1);
    const baseUpstreamRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;

    const initTimeoutOverride = config.modelAttributes?.responses_init_timeout_ms;
    const initTimeoutMs =
      typeof initTimeoutOverride === 'number' && Number.isFinite(initTimeoutOverride) && initTimeoutOverride >= 0
        ? initTimeoutOverride
        : Math.min(
            30_000,
            typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs)
              ? requestTimeoutMs
              : 30_000
          );

    return await processOpenAIResponsesStreamToSseWithRetry({
      client,
      requestParams,
      upstreamRequestStartedAt: Date.now(),
      reply,
      responseHeaders,
      baseUpstreamRequestOptions,
      abortSignal,
      totalAttempts,
      initTimeoutMs,
      streamIdleTimeoutMs: this.resolveStreamIdleTimeoutMs(config, options),
      streamRestorer,
      logger: memoryLogger,
    });
  }
}
