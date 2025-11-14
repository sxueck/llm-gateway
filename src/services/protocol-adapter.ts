import OpenAI from 'openai';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import { extractReasoningFromChoice } from '../utils/request-logger.js';
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
        maxRetries: 0,
        timeout: 60000,
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
      memoryLogger.debug(`创建 OpenAI 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'}`, 'Protocol');
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
    options: any
  ): Promise<ProtocolResponse> {
    memoryLogger.debug(
      `直接转发请求 | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiChatCompletion(config, messages, options);
  }

  private async openaiChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any
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

    if (config.modelAttributes?.supports_reasoning) {
      requestParams.extra_body = {
        ...requestParams.extra_body,
        enable_thinking: true,
      };
    }

    if (config.modelAttributes?.supports_interleaved_thinking) {
      requestParams.extra_body = {
        ...requestParams.extra_body,
        reasoning_split: true,
      };
    }

    const response = await client.chat.completions.create(requestParams);

    return response as any;
  }

  async streamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    memoryLogger.debug(
      `直接转发流式请求 | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiStreamChatCompletion(config, messages, options, reply);
  }

  private async openaiStreamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
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

    if (config.modelAttributes?.supports_reasoning) {
      requestParams.extra_body = {
        ...requestParams.extra_body,
        enable_thinking: true,
      };
    }

    if (config.modelAttributes?.supports_interleaved_thinking) {
      requestParams.extra_body = {
        ...requestParams.extra_body,
        reasoning_split: true,
      };
    }

    const stream = await client.chat.completions.create(requestParams) as unknown as AsyncIterable<any>;

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
    const streamChunks: string[] = [];
    let reasoningContent = '';
    let thinkingBlocks: ThinkingBlock[] = [];
    let toolCalls: any[] = [];

    for await (const chunk of stream) {
      const chunkData = JSON.stringify(chunk);
      const sseData = `data: ${chunkData}\n\n`;

      streamChunks.push(sseData);
      reply.raw.write(sseData);

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || promptTokens;
        completionTokens = chunk.usage.completion_tokens || completionTokens;
        totalTokens = chunk.usage.total_tokens || totalTokens;
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

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      streamChunks,
      reasoningContent: reasoningContent || undefined,
      thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined
    };
  }

  async createEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any = {}
  ): Promise<any> {
    memoryLogger.debug(
      `直接转发 Embeddings 请求 | model: ${config.model}`,
      'Protocol'
    );

    return await this.openaiCreateEmbedding(config, input, options);
  }

  private async openaiCreateEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any
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

    const response = await client.embeddings.create(requestParams);

    return response;
  }
}