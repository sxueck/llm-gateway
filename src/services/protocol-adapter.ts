import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
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
  private anthropicClients: Map<string, Anthropic> = new Map();

  private getOpenAIClient(config: ProtocolConfig): OpenAI {
    const cacheKey = `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.openaiClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeout: 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      this.openaiClients.set(cacheKey, new OpenAI(clientConfig));
      memoryLogger.debug(`创建 OpenAI 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'}`, 'Protocol');
    }

    return this.openaiClients.get(cacheKey)!;
  }

  private getAnthropicClient(config: ProtocolConfig): Anthropic {
    const cacheKey = `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.anthropicClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeout: 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      this.anthropicClients.set(cacheKey, new Anthropic(clientConfig));
      memoryLogger.debug(`创建 Anthropic 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'}`, 'Protocol');
    }

    return this.anthropicClients.get(cacheKey)!;
  }

  private detectProtocol(provider: string, protocol?: string): string {
    if (protocol) {
      return protocol.toLowerCase();
    }

    const normalized = provider.toLowerCase();

    if (normalized === 'claude' || normalized.includes('anthropic')) {
      return 'anthropic';
    }

    if (normalized === 'gemini' || normalized.includes('google')) {
      return 'google';
    }

    return 'openai';
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

  private convertToAnthropicFormat(messages: any[], supportsCaching: boolean = false): { system?: string | any[]; messages: any[] } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    let system: string | any[] | undefined;

    if (systemMessages.length > 0) {
      const systemContent = systemMessages.map(m => m.content).join('\n');

      if (supportsCaching) {
        system = [
          {
            type: 'text',
            text: systemContent,
            cache_control: { type: 'ephemeral' }
          }
        ];
      } else {
        system = systemContent;
      }
    }

    return {
      system,
      messages: nonSystemMessages
    };
  }

  private convertAnthropicToOpenAIFormat(response: any): ProtocolResponse {
    return {
      id: response.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response.content[0]?.text || '',
        },
        finish_reason: response.stop_reason || 'stop'
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      }
    };
  }

  async chatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any
  ): Promise<ProtocolResponse> {
    const protocol = this.detectProtocol(config.provider, config.protocol);

    memoryLogger.debug(
      `协议适配器请求 | protocol: ${protocol} | model: ${config.model}`,
      'Protocol'
    );

    if (protocol === 'anthropic') {
      return await this.anthropicChatCompletion(config, messages, options);
    }

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
    // 优先使用 max_tokens,如果不存在则使用 max_completion_tokens
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
    if (options.tools !== undefined) requestParams.tools = options.tools;
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

  private async anthropicChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any
  ): Promise<ProtocolResponse> {
    const client = this.getAnthropicClient(config);
    const cleanedMessages = this.validateAndCleanMessages(messages);
    const supportsCaching = config.modelAttributes?.supports_prompt_caching || false;
    const { system, messages: anthropicMessages } = this.convertToAnthropicFormat(cleanedMessages, supportsCaching);

    const requestParams: any = {
      model: config.model,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || 4096,
    };

    if (system) {
      requestParams.system = system;
    }

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    }

    if (options.top_p !== undefined) {
      requestParams.top_p = options.top_p;
    }

    if (options.top_k !== undefined) {
      requestParams.top_k = options.top_k;
    }

    if (options.stop_sequences !== undefined) {
      requestParams.stop_sequences = options.stop_sequences;
    }

    const response = await client.messages.create(requestParams);

    return this.convertAnthropicToOpenAIFormat(response);
  }

  async streamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    const protocol = this.detectProtocol(config.provider, config.protocol);

    memoryLogger.debug(
      `协议适配器流式请求 | protocol: ${protocol} | model: ${config.model}`,
      'Protocol'
    );

    if (protocol === 'anthropic') {
      return await this.anthropicStreamChatCompletion(config, messages, options, reply);
    }

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
    // 优先使用 max_tokens,如果不存在则使用 max_completion_tokens
    if (options.max_tokens !== undefined) {
      requestParams.max_tokens = options.max_tokens;
    } else if (options.max_completion_tokens !== undefined) {
      requestParams.max_tokens = options.max_completion_tokens;
    }
    if (options.tools !== undefined) requestParams.tools = options.tools;
    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
    if (options.parallel_tool_calls !== undefined) requestParams.parallel_tool_calls = options.parallel_tool_calls;
    if (options.top_p !== undefined) requestParams.top_p = options.top_p;
    if (options.frequency_penalty !== undefined) requestParams.frequency_penalty = options.frequency_penalty;
    if (options.presence_penalty !== undefined) requestParams.presence_penalty = options.presence_penalty;
    if (options.stop !== undefined) requestParams.stop = options.stop;
    if (options.n !== undefined) requestParams.n = options.n;
    if (options.tools !== undefined) requestParams.tools = options.tools;
    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
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

  private async anthropicStreamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    const client = this.getAnthropicClient(config);
    const cleanedMessages = this.validateAndCleanMessages(messages);
    const supportsCaching = config.modelAttributes?.supports_prompt_caching || false;
    const { system, messages: anthropicMessages } = this.convertToAnthropicFormat(cleanedMessages, supportsCaching);

    const requestParams: any = {
      model: config.model,
      messages: anthropicMessages,
      max_tokens: options.max_tokens || 4096,
      stream: true,
    };

    if (system) {
      requestParams.system = system;
    }

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    }

    if (options.top_p !== undefined) {
      requestParams.top_p = options.top_p;
    }

    if (options.top_k !== undefined) {
      requestParams.top_k = options.top_k;
    }

    if (options.stop_sequences !== undefined) {
      requestParams.stop_sequences = options.stop_sequences;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    let promptTokens = 0;
    let completionTokens = 0;
    const streamChunks: string[] = [];
    let contentBuffer = '';

    const stream = await client.messages.stream(requestParams);

    for await (const event of stream) {
      if (event.type === 'message_start') {
        promptTokens = event.message.usage.input_tokens;
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          contentBuffer += event.delta.text;
          
          const openaiChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: config.model,
            choices: [{
              index: 0,
              delta: { content: event.delta.text },
              finish_reason: null
            }]
          };

          const sseData = `data: ${JSON.stringify(openaiChunk)}\n\n`;
          streamChunks.push(sseData);
          reply.raw.write(sseData);
        }
      } else if (event.type === 'message_delta') {
        if (event.usage) {
          completionTokens = event.usage.output_tokens;
        }
      }
    }

    const usageChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: config.model,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };

    const usageSseData = `data: ${JSON.stringify(usageChunk)}\n\n`;
    streamChunks.push(usageSseData);
    reply.raw.write(usageSseData);

    const finalChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: config.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }]
    };

    const finalSseData = `data: ${JSON.stringify(finalChunk)}\n\n`;
    streamChunks.push(finalSseData);
    reply.raw.write(finalSseData);

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      streamChunks,
    };
  }

  async createEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any = {}
  ): Promise<any> {
    const protocol = this.detectProtocol(config.provider, config.protocol);

    memoryLogger.debug(
      `协议适配器 Embeddings 请求 | protocol: ${protocol} | model: ${config.model}`,
      'Protocol'
    );

    if (protocol === 'anthropic') {
      throw new Error('Anthropic 不支持 embeddings API');
    }

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