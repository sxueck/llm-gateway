import OpenAI from 'openai';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import { extractReasoningFromChoice } from '../utils/request-logger.js';
import { normalizeUsageCounts } from '../utils/usage-normalizer.js';
import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';

export interface ProtocolConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
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
      `直接转发请求 | model: ${config.model}`,
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
      `直接转发流式请求 | model: ${config.model}`,
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
      `直接转发 Embeddings 请求 | model: ${config.model}`,
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

    const stream = await client.responses.create(
      requestParams,
      Object.keys(requestOptions).length > 0 ? requestOptions : undefined
    ) as unknown as AsyncIterable<any>;

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

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    const streamChunks: string[] = [];

    try {
      for await (const chunk of stream) {
        // 检查客户端是否断开连接
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          memoryLogger.info('客户端已断开连接，停止流式传输', 'Protocol');
          break;
        }

        // 移除 instructions 字段避免泄露
        if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
          delete (chunk as any).instructions;
        }

        const chunkData = JSON.stringify(chunk);
        const sseData = `data: ${chunkData}\n\n`;

        streamChunks.push(sseData);

        // 使用背压控制优化内存
        if (!reply.raw.write(sseData)) {
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }

        // 从 Responses API 流中提取 usage 信息（支持根级与 response.usage），统一归一化
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
    } catch (error: any) {
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
    };
  }
}
