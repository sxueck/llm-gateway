import OpenAI from 'openai';
import { FastifyReply } from 'fastify';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { memoryLogger } from './logger.js';
import { extractReasoningFromChoice } from '../utils/request-logger.js';
import { normalizeUsageCounts } from '../utils/usage-normalizer.js';
import { createInitialAggregate, processResponsesEvent, type ResponsesAggregate } from '../utils/responses-parser.js';
import { EmptyOutputError } from '../errors/empty-output-error.js';
import { StreamRetryManager, StreamBuffer, getRetryLimit, type StreamProcessor } from '../utils/stream-retry-manager.js';
import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';
import { ResponsesEmptyOutputError } from '../errors/responses-empty-output-error.js';

// Responses API 空输出重试默认次数（可通过环境变量或模型属性配置）
const DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES = Math.max(
  parseInt(process.env.RESPONSES_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

function responsesEventHasAssistantContent(event: any): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }

  if (typeof event.type === 'string' && event.type.startsWith('response.output_')) {
    return true;
  }

  if (Array.isArray((event as any).output) && (event as any).output.length > 0) {
    return true;
  }

  const responseOutput = (event as any).response?.output;
  if (Array.isArray(responseOutput) && responseOutput.length > 0) {
    return true;
  }

  if (event.delta && typeof event.delta === 'object' && Object.keys(event.delta).length > 0) {
    return true;
  }

  return false;
}

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
  private openaiClients: Map<string, OpenAI> = new Map();
  private keepAliveAgents: Map<string, { httpAgent: HttpAgent; httpsAgent: HttpsAgent }> = new Map();
  private readonly keepAliveMaxSockets = parseInt(process.env.HTTP_KEEP_ALIVE_MAX_SOCKETS || '64', 10);

  /**
   * 生成稳定的 headers 缓存 key
   * 通过对键排序并拼接键值对来生成稳定的标识符
   */
  private getHeadersCacheKey(headers?: Record<string, string>): string {
    if (!headers || Object.keys(headers).length === 0) {
      return '';
    }

    // 按键排序后拼接，确保相同的 headers 对象生成相同的 key
    return Object.keys(headers)
      .sort()
      .map(key => `${key}:${headers[key]}`)
      .join('|');
  }

  private getKeepAliveAgents(cacheKey: string): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
    if (!this.keepAliveAgents.has(cacheKey)) {
      const httpAgent = new HttpAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: this.keepAliveMaxSockets,
      });
      const httpsAgent = new HttpsAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: this.keepAliveMaxSockets,
      });
      this.keepAliveAgents.set(cacheKey, { httpAgent, httpsAgent });
    }

    return this.keepAliveAgents.get(cacheKey)!;
  }

  private getOpenAIClient(config: ProtocolConfig): OpenAI {
    // 使用优化的 headers key 生成方式，避免 JSON.stringify 导致的缓存失效
    const headersKey = this.getHeadersCacheKey(config.modelAttributes?.headers);
    const cacheKey = headersKey
      ? `${config.provider}-${config.baseUrl || 'default'}-${headersKey}`
      : `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.openaiClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: config.modelAttributes?.maxRetries ?? 2, // 恢复默认重试
        timeout: config.modelAttributes?.timeout ?? 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      const keepAliveAgents = this.getKeepAliveAgents(cacheKey);
      clientConfig.httpAgent = keepAliveAgents.httpAgent;
      clientConfig.httpsAgent = keepAliveAgents.httpsAgent;

      // 添加自定义请求头支持
      if (config.modelAttributes?.headers && Object.keys(config.modelAttributes.headers).length > 0) {
        clientConfig.defaultHeaders = config.modelAttributes.headers;
        memoryLogger.debug(
          `添加自定义请求头 | provider: ${config.provider} | headers: ${JSON.stringify(config.modelAttributes.headers)}`,
          'Protocol'
        );
      }

      this.openaiClients.set(cacheKey, new OpenAI(clientConfig));
      memoryLogger.debug(
        `创建 OpenAI 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'} | maxRetries: ${clientConfig.maxRetries}`,
        'Protocol'
      );
    }

    return this.openaiClients.get(cacheKey)!;
  }

  private validateAndCleanMessages(messages: any[]): any[] {
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

    return cleanedMessages;
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

    const cleanedMessages = this.validateAndCleanMessages(messages);

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

    // 构建请求选项，支持超时和取消
    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

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

    const cleanedMessages = this.validateAndCleanMessages(messages);

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

    // 构建请求选项，支持超时和取消
    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
    }

    const stream = await client.chat.completions.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    ) as unknown as AsyncIterable<any>;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    const streamChunks: string[] = [];
    let reasoningContent = '';
    let thinkingBlocks: ThinkingBlock[] = [];
    let toolCalls: any[] = [];

    try {
      for await (const chunk of stream) {
        // 检查客户端是否断开连接
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          memoryLogger.info('客户端已断开连接，停止流式传输', 'Protocol');
          break;
        }

        if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
          delete (chunk as any).instructions;
        }

        const chunkData = JSON.stringify(chunk);
        const sseData = `data: ${chunkData}\n\n`;

        streamChunks.push(sseData);

        // 使用背压控制优化内存
        if (!reply.raw.write(sseData)) {
          // 如果写入缓冲区已满，等待 drain 事件
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }

        if (chunk.usage) {
          const norm = normalizeUsageCounts(chunk.usage);
          // 只有当新值大于当前值时才更新，避免0值被||运算符忽略
          if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) {
            promptTokens = norm.promptTokens;
          }
          if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) {
            completionTokens = norm.completionTokens;
          }
          if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) {
            totalTokens = norm.totalTokens;
          } else if (promptTokens > 0 || completionTokens > 0) {
            totalTokens = promptTokens + completionTokens;
          }
          if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) {
            cachedTokens = norm.cachedTokens;
          }
        }

        if (chunk.choices && chunk.choices[0]) {
          const extraction = extractReasoningFromChoice(
            chunk.choices[0],
            reasoningContent,
            thinkingBlocks,
            toolCalls
          );
          reasoningContent = extraction.reasoningContent;
          thinkingBlocks = extraction.thinkingBlocks as ThinkingBlock[];
          toolCalls = extraction.toolCalls || [];
        }
      }
    } catch (error: any) {
      // 检查是否是用户取消
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        memoryLogger.info('流式请求被用户取消', 'Protocol');
      }
      throw error;
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      streamChunks,
      reasoningContent: reasoningContent || undefined,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined
    };
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

    // Google Gemini 已通过 ProviderAdapter 转换为 OpenAI 兼容���口
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

    const response = await client.embeddings.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    );

    return response;
  }

  private buildResponsesRequestParams(options: any, includePreviousResponseId: boolean): any {
    const params: any = {};
    if (options.instructions !== undefined) params.instructions = options.instructions;
    // 核心调参字段
    if (options.temperature !== undefined) params.temperature = options.temperature;
    if (options.max_output_tokens !== undefined) params.max_output_tokens = options.max_output_tokens;
    if (options.top_p !== undefined) params.top_p = options.top_p;
    if (options.store !== undefined) params.store = options.store;
    if (options.metadata !== undefined) params.metadata = options.metadata;
    if (options.tools !== undefined) params.tools = options.tools;
    if (options.tool_choice !== undefined) params.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) params.parallel_tool_calls = options.parallel_tool_calls;
    // 透传 MCP 配置（用于远程 MCP servers），与工具定义中的 type: 'mcp' 一起生效
    if ((options as any).mcp !== undefined) (params as any).mcp = (options as any).mcp;
    if (options.reasoning !== undefined) params.reasoning = options.reasoning;
    if (options.text !== undefined) params.text = options.text;
    if (includePreviousResponseId && options.previous_response_id !== undefined) params.previous_response_id = options.previous_response_id;
    if (options.truncation !== undefined) params.truncation = options.truncation;
    if (options.user !== undefined) params.user = options.user;
    if (options.include !== undefined) params.include = options.include;
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

    const requestParams: any = {
      model: config.model,
      input,
      stream: true,
    };

    // 添加 Responses API 支持的参数
    Object.assign(requestParams, this.buildResponsesRequestParams(options, false));

    // 构建请求选项
    const requestOptions: any = {};
    if (options.requestTimeout !== undefined) {
      requestOptions.timeout = options.requestTimeout;
    }
    if (abortSignal) {
      requestOptions.signal = abortSignal;
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

    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    };
    if ((options as any).conversationId) {
      responseHeaders['X-Conversation-Id'] = String((options as any).conversationId);
    }
    if ((options as any).sessionId) {
      responseHeaders['X-Session-Id'] = String((options as any).sessionId);
    }

    reply.raw.writeHead(200, responseHeaders);

    const modelRetryLimit = typeof config.modelAttributes?.responses_empty_retry_limit === 'number'
      ? Math.max(0, Math.floor(config.modelAttributes.responses_empty_retry_limit))
      : DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES;
    const totalAttempts = Math.max(1, modelRetryLimit + 1);
    const upstreamRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;

    let finalPromptTokens = 0;
    let finalCompletionTokens = 0;
    let finalTotalTokens = 0;
    let finalCachedTokens = 0;
    let finalStreamChunks: string[] = [];
    let success = false;
    let lastEmptyError: ResponsesEmptyOutputError | null = null;

    attemptLoop: for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (abortSignal?.aborted) {
        const abortError = new Error('Request aborted');
        (abortError as any).name = 'AbortError';
        throw abortError;
      }

      const attemptStreamChunks: string[] = [];
      const pendingChunks: string[] = [];
      let buffering = true;
      let hasAssistantOutput = false;
      let bypassEmptyGuard = false;
      let responsesAggregate = createInitialAggregate();

      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let cachedTokens = 0;

      const writeChunk = async (data: string) => {
        attemptStreamChunks.push(data);
        if (!reply.raw.write(data)) {
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }
      };

      const flushPendingChunks = async () => {
        if (!buffering) return;
        buffering = false;
        while (pendingChunks.length > 0) {
          const buffered = pendingChunks.shift()!;
          await writeChunk(buffered);
        }
      };

      const enqueueChunk = async (data: string) => {
        if (buffering) {
          pendingChunks.push(data);
        } else {
          await writeChunk(data);
        }
      };

      try {
        const stream = await client.responses.create(
          requestParams,
          upstreamRequestOptions
        ) as unknown as AsyncIterable<any>;

        for await (const chunk of stream) {
          if (reply.raw.destroyed || reply.raw.writableEnded) {
            memoryLogger.info('客户端已断开连接，停止流式传输', 'Protocol');
            break;
          }

          if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
            delete (chunk as any).instructions;
          }

          const chunkData = JSON.stringify(chunk);
          const sseData = `data: ${chunkData}\n\n`;

          await enqueueChunk(sseData);

          const previousLength = responsesAggregate.outputText.length;
          const updatedAggregate = processResponsesEvent(responsesAggregate, chunk as any);
          const producedText = updatedAggregate.outputText.length > previousLength;
          responsesAggregate = updatedAggregate;

          if (!hasAssistantOutput && (producedText || responsesEventHasAssistantContent(chunk))) {
            hasAssistantOutput = true;
            await flushPendingChunks();
          }

          if ((chunk as any)?.type === 'response.error' || (chunk as any)?.error) {
            bypassEmptyGuard = true;
            await flushPendingChunks();
          }

          const usageInChunk: any = (chunk?.usage ?? (chunk?.response && (chunk.response as any).usage) ?? null);
          if (usageInChunk) {
            const norm = normalizeUsageCounts(usageInChunk);
            if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) {
              promptTokens = norm.promptTokens;
            }
            if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) {
              completionTokens = norm.completionTokens;
            }
            if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) {
              totalTokens = norm.totalTokens;
            } else if (promptTokens > 0 || completionTokens > 0) {
              totalTokens = promptTokens + completionTokens;
            }
            if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) {
              cachedTokens = norm.cachedTokens;
            }
          }
        }

        if (!hasAssistantOutput && !bypassEmptyGuard) {
          lastEmptyError = new ResponsesEmptyOutputError(
            'Responses API stream completed without assistant output',
            {
              attempt,
              totalAttempts,
              status: responsesAggregate.status,
              lastEventType: responsesAggregate.lastEventType,
              responseId: responsesAggregate.id,
            }
          );

          memoryLogger.warn(
            `[Responses API] 未检测到 assistant 输出，准备重试 | attempt ${attempt}/${totalAttempts} | ` +
            `status=${responsesAggregate.status} | last_event=${responsesAggregate.lastEventType || 'unknown'}`,
            'Protocol'
          );

          continue attemptLoop;
        }

        finalPromptTokens = promptTokens;
        finalCompletionTokens = completionTokens;
        finalTotalTokens = totalTokens;
        finalCachedTokens = cachedTokens;
        finalStreamChunks = attemptStreamChunks;
        success = true;
        break;
      } catch (error: any) {
        if (error.name === 'AbortError' || abortSignal?.aborted) {
          memoryLogger.info('流式请求被用户取消', 'Protocol');
        }
        throw error;
      }
    }

    if (!success) {
      const errorToThrow =
        lastEmptyError ||
        new ResponsesEmptyOutputError('Responses API stream ended without assistant output', {
          totalAttempts,
        });
      memoryLogger.error(
        `[Responses API] 多次尝试仍为空返回，终止请求 | attempts=${totalAttempts}`,
        'Protocol'
      );
      throw errorToThrow;
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }

    return {
      promptTokens: finalPromptTokens,
      completionTokens: finalCompletionTokens,
      totalTokens: finalTotalTokens,
      cachedTokens: finalCachedTokens,
      streamChunks: finalStreamChunks,
    };
  }
}
