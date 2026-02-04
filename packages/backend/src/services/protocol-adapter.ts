import OpenAI from 'openai';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';
import { AifwStreamRestorer, restorePlaceholdersInObjectInPlace } from '../utils/aifw-placeholders.js';
import { AifwClient } from './aifw-client.js';
import { AifwRemoteStreamRestorer } from './aifw-remote-stream-restorer.js';
import { HttpClientFactory } from './http-client-factory.js';
import { processOpenAIChatCompletionStreamToSse } from '../utils/stream-processor.js';
import {
  DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES,
  processOpenAIResponsesStreamToSseWithRetry,
} from '../utils/responses-stream-processor.js';
import { filterForwardedHeaders } from '../utils/header-sanitizer.js';

export interface ProtocolConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  nativeBaseUrl?: string;
  model: string;
  protocol?: string;
  modelAttributes?: any;
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
      throw new Error('messages 数组不能为空');
    }

    const cleanedMessages = messages.filter(msg => {
      if (!msg || typeof msg !== 'object') {
        return false;
      }

      if (msg.role === 'tool') {
        return msg.tool_call_id && msg.content;
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
      throw new Error('过滤后的 messages 数组为空，所有消息内容均为空白');
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

    // Google Gemini 已通过 ProviderAdapter 转换为 OpenAI 兼容接口，可以直接复用 OpenAI 逻辑
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

    if (options.temperature !== undefined) requestParams.temperature = options.temperature;
    if (options.max_tokens !== undefined) {
      requestParams.max_tokens = options.max_tokens;
    } else if (options.max_completion_tokens !== undefined) {
      requestParams.max_tokens = options.max_completion_tokens;
    }
    if (options.top_p !== undefined) requestParams.top_p = options.top_p;
    if (options.frequency_penalty !== undefined) requestParams.frequency_penalty = options.frequency_penalty;
    if (options.presence_penalty !== undefined) requestParams.presence_penalty = options.presence_penalty;
    if (options.stop !== undefined) requestParams.stop = options.stop;
    if (options.n !== undefined) requestParams.n = options.n;
    if (options.logit_bias !== undefined) requestParams.logit_bias = options.logit_bias;
    if (options.user !== undefined) requestParams.user = options.user;

    if (options.tools !== undefined) {
      requestParams.tools = options.tools;
    }

    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) requestParams.parallel_tool_calls = options.parallel_tool_calls;
    if (options.response_format !== undefined) requestParams.response_format = options.response_format;
    if (options.seed !== undefined) requestParams.seed = options.seed;
    if (options.store !== undefined) requestParams.store = options.store;
    // stream_options is only valid for stream=true requests
    if ((options as any).service_tier !== undefined) (requestParams as any).service_tier = (options as any).service_tier;
    if ((options as any).prompt_cache_key !== undefined) (requestParams as any).prompt_cache_key = (options as any).prompt_cache_key;
    if ((options as any).safety_identifier !== undefined) (requestParams as any).safety_identifier = (options as any).safety_identifier;
    if ((options as any).reasoning_effort !== undefined) (requestParams as any).reasoning_effort = (options as any).reasoning_effort;
    if ((options as any).verbosity !== undefined) (requestParams as any).verbosity = (options as any).verbosity;
    if ((options as any).thinking !== undefined) (requestParams as any).thinking = (options as any).thinking;

    // 构建请求选项，支持超时和取消
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

    // Google Gemini 已通过 ProviderAdapter 转换为 OpenAI 兼容接口，可以直接复用 OpenAI 逻辑
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
    const aifwCtx = (options as any)?.__aifw;
    const placeholdersMap = aifwCtx?.placeholdersMap;
    const streamRestorer = placeholdersMap ? new AifwStreamRestorer(placeholdersMap) : null;
    const canUseRemoteAifwRestore =
      !!aifwCtx?.maskMeta &&
      (!placeholdersMap || Object.keys(placeholdersMap).length === 0) &&
      !!aifwCtx?.clientConfig?.baseUrl;
    const remoteAifwClient = canUseRemoteAifwRestore
      ? new AifwClient({
          baseUrl: aifwCtx.clientConfig.baseUrl,
          httpApiKey: aifwCtx.clientConfig.httpApiKey,
          timeoutMs: aifwCtx.clientConfig.timeoutMs,
        })
      : null;
    const remoteStreamRestorer = remoteAifwClient
      ? new AifwRemoteStreamRestorer(remoteAifwClient, aifwCtx.maskMeta)
      : null;
    const cleanedMessages = this.validateAndCleanMessages(messages, options);

    const requestParams: any = {
      model: config.model,
      messages: cleanedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.temperature !== undefined) requestParams.temperature = options.temperature;
    if (options.max_tokens !== undefined) {
      requestParams.max_tokens = options.max_tokens;
    } else if (options.max_completion_tokens !== undefined) {
      requestParams.max_tokens = options.max_completion_tokens;
    }

    if (options.tools !== undefined) {
      requestParams.tools = options.tools;
    }

    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) requestParams.parallel_tool_calls = options.parallel_tool_calls;
    if (options.top_p !== undefined) requestParams.top_p = options.top_p;
    if (options.frequency_penalty !== undefined) requestParams.frequency_penalty = options.frequency_penalty;
    if (options.presence_penalty !== undefined) requestParams.presence_penalty = options.presence_penalty;
    if (options.stop !== undefined) requestParams.stop = options.stop;
    if (options.n !== undefined) requestParams.n = options.n;
    if (options.response_format !== undefined) requestParams.response_format = options.response_format;
    if (options.seed !== undefined) requestParams.seed = options.seed;
    if (options.store !== undefined) requestParams.store = options.store;
    if ((options as any).stream_options !== undefined) {
      // Always include usage for internal accounting.
      requestParams.stream_options = { ...(options as any).stream_options, include_usage: true };
    }
    if ((options as any).service_tier !== undefined) (requestParams as any).service_tier = (options as any).service_tier;
    if ((options as any).prompt_cache_key !== undefined) (requestParams as any).prompt_cache_key = (options as any).prompt_cache_key;
    if ((options as any).safety_identifier !== undefined) (requestParams as any).safety_identifier = (options as any).safety_identifier;
    if ((options as any).reasoning_effort !== undefined) (requestParams as any).reasoning_effort = (options as any).reasoning_effort;
    if ((options as any).verbosity !== undefined) (requestParams as any).verbosity = (options as any).verbosity;
    if ((options as any).thinking !== undefined) (requestParams as any).thinking = (options as any).thinking;

    // 构建请求选项，支持超时和取消
    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    this.applyForwardedHeadersToRequestOptions(requestOptions, config, options);

    const stream = await client.chat.completions.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    ) as unknown as AsyncIterable<any>;
    return await processOpenAIChatCompletionStreamToSse({
      reply,
      stream,
      model: config.model,
      abortSignal,
      placeholdersMap,
      restorePlaceholdersInObjectInPlace,
      streamRestorer,
      remoteStreamRestorer,
      logger: memoryLogger,
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

    // Google Gemini 已通过 ProviderAdapter 转换为 OpenAI 兼容接口
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

    // 构建请求选项
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
    if (options.instructions !== undefined) params.instructions = options.instructions;
    if ((options as any).background !== undefined) (params as any).background = (options as any).background;
    if ((options as any).conversation !== undefined) (params as any).conversation = (options as any).conversation;
    // 核心调参字段
    if (options.temperature !== undefined) params.temperature = options.temperature;
    if (options.top_p !== undefined) params.top_p = options.top_p;
    if (options.store !== undefined) params.store = options.store;
    if (options.metadata !== undefined) params.metadata = options.metadata;
    if (options.tools !== undefined) params.tools = options.tools;
    if (options.tool_choice !== undefined) params.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) params.parallel_tool_calls = options.parallel_tool_calls;
    if ((options as any).stream_options !== undefined) (params as any).stream_options = (options as any).stream_options;
    if ((options as any).service_tier !== undefined) (params as any).service_tier = (options as any).service_tier;
    // 透传 MCP 配置（用于远程 MCP servers），与工具定义中的 type: 'mcp' 一起生效
    if ((options as any).mcp !== undefined) (params as any).mcp = (options as any).mcp;
    if (options.reasoning !== undefined) params.reasoning = options.reasoning;
    if ((options as any).thinking !== undefined) (params as any).thinking = (options as any).thinking;
    if (options.text !== undefined) params.text = options.text;
    if (includePreviousResponseId && options.previous_response_id !== undefined) params.previous_response_id = options.previous_response_id;
    if ((options as any).max_tool_calls !== undefined) (params as any).max_tool_calls = (options as any).max_tool_calls;
    if (options.truncation !== undefined) params.truncation = options.truncation;
    if (options.user !== undefined) params.user = options.user;
    if (options.include !== undefined) params.include = options.include;
    if ((options as any).prompt_cache_key !== undefined) (params as any).prompt_cache_key = (options as any).prompt_cache_key;
    if ((options as any).safety_identifier !== undefined) (params as any).safety_identifier = (options as any).safety_identifier;
    return params;
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

    // 添加 Responses API 支持的参数
    Object.assign(requestParams, this.buildResponsesRequestParams(options, true));

    // 构建请求选项
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
    const aifwCtx = (options as any)?.__aifw;
    const placeholdersMap = aifwCtx?.placeholdersMap;
    const streamRestorer = placeholdersMap ? new AifwStreamRestorer(placeholdersMap) : null;
    const canUseRemoteAifwRestore =
      !!aifwCtx?.maskMeta &&
      (!placeholdersMap || Object.keys(placeholdersMap).length === 0) &&
      !!aifwCtx?.clientConfig?.baseUrl;
    const remoteAifwClient = canUseRemoteAifwRestore
      ? new AifwClient({
          baseUrl: aifwCtx.clientConfig.baseUrl,
          httpApiKey: aifwCtx.clientConfig.httpApiKey,
          timeoutMs: aifwCtx.clientConfig.timeoutMs,
        })
      : null;
    const remoteStreamRestorer = remoteAifwClient
      ? new AifwRemoteStreamRestorer(remoteAifwClient, aifwCtx.maskMeta)
      : null;

    const requestParams: any = {
      model: config.model,
      input,
      stream: true,
    };

    // 添加 Responses API 支持的参数（允许 previous_response_id 以支持多轮衔接）
    Object.assign(requestParams, this.buildResponsesRequestParams(options, true));

    // 构建请求选项
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

    const initTimeoutMs = Math.min(
      8_000,
      typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs)
        ? requestTimeoutMs
        : 8_000
    );

    return await processOpenAIResponsesStreamToSseWithRetry({
      client,
      requestParams,
      reply,
      responseHeaders,
      baseUpstreamRequestOptions,
      abortSignal,
      totalAttempts,
      initTimeoutMs,
      placeholdersMap,
      restorePlaceholdersInObjectInPlace,
      streamRestorer,
      remoteStreamRestorer,
      logger: memoryLogger,
    });
  }
}
