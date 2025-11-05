import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import { extractReasoningFromChoice } from '../utils/request-logger.js';
import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';

export interface LiteLLMConfig {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface LiteLLMResponse {
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

export class LiteLLMAdapter {
  private openaiClients: Map<string, OpenAI> = new Map();
  private anthropicClients: Map<string, Anthropic> = new Map();

  private getOpenAIClient(config: LiteLLMConfig): OpenAI {
    const cacheKey = `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.openaiClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: 3,
        timeout: 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      this.openaiClients.set(cacheKey, new OpenAI(clientConfig));
      memoryLogger.debug(`创建 OpenAI 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'}`, 'LiteLLM');
    }

    return this.openaiClients.get(cacheKey)!;
  }

  private getAnthropicClient(config: LiteLLMConfig): Anthropic {
    const cacheKey = `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.anthropicClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: 3,
        timeout: 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      this.anthropicClients.set(cacheKey, new Anthropic(clientConfig));
      memoryLogger.debug(`创建 Anthropic 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'}`, 'LiteLLM');
    }

    return this.anthropicClients.get(cacheKey)!;
  }

  private normalizeProvider(provider: string): string {
    const normalized = provider.toLowerCase();
    
    if (normalized === 'claude' || normalized.includes('anthropic')) {
      return 'anthropic';
    }
    
    if (normalized === 'gemini' || normalized.includes('google')) {
      return 'google';
    }
    
    return 'openai';
  }

  private convertToAnthropicFormat(messages: any[]): { system?: string; messages: any[] } {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    const system = systemMessages.length > 0 
      ? systemMessages.map(m => m.content).join('\n')
      : undefined;

    return {
      system,
      messages: nonSystemMessages
    };
  }

  private convertAnthropicToOpenAIFormat(response: any): LiteLLMResponse {
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
    config: LiteLLMConfig,
    messages: any[],
    options: any
  ): Promise<LiteLLMResponse> {
    const normalizedProvider = this.normalizeProvider(config.provider);

    memoryLogger.debug(
      `LiteLLM 请求 | provider: ${normalizedProvider} | model: ${config.model}`,
      'LiteLLM'
    );

    if (normalizedProvider === 'anthropic') {
      return await this.anthropicChatCompletion(config, messages, options);
    }

    return await this.openaiChatCompletion(config, messages, options);
  }

  private async openaiChatCompletion(
    config: LiteLLMConfig,
    messages: any[],
    options: any
  ): Promise<LiteLLMResponse> {
    const client = this.getOpenAIClient(config);

    const requestParams: any = {
      model: config.model,
      messages,
      stream: false,
    };

    if (options.temperature !== undefined) requestParams.temperature = options.temperature;
    if (options.max_tokens !== undefined) requestParams.max_tokens = options.max_tokens;
    if (options.top_p !== undefined) requestParams.top_p = options.top_p;
    if (options.frequency_penalty !== undefined) requestParams.frequency_penalty = options.frequency_penalty;
    if (options.presence_penalty !== undefined) requestParams.presence_penalty = options.presence_penalty;
    if (options.stop !== undefined) requestParams.stop = options.stop;
    if (options.n !== undefined) requestParams.n = options.n;
    if (options.logit_bias !== undefined) requestParams.logit_bias = options.logit_bias;
    if (options.user !== undefined) requestParams.user = options.user;
    if (options.tools !== undefined) requestParams.tools = options.tools;
    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
    if (options.response_format !== undefined) requestParams.response_format = options.response_format;
    if (options.seed !== undefined) requestParams.seed = options.seed;

    const response = await client.chat.completions.create(requestParams);

    return response as any;
  }

  private async anthropicChatCompletion(
    config: LiteLLMConfig,
    messages: any[],
    options: any
  ): Promise<LiteLLMResponse> {
    const client = this.getAnthropicClient(config);
    const { system, messages: anthropicMessages } = this.convertToAnthropicFormat(messages);

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
    config: LiteLLMConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    const normalizedProvider = this.normalizeProvider(config.provider);

    memoryLogger.debug(
      `LiteLLM 流式请求 | provider: ${normalizedProvider} | model: ${config.model}`,
      'LiteLLM'
    );

    if (normalizedProvider === 'anthropic') {
      return await this.anthropicStreamChatCompletion(config, messages, options, reply);
    }

    return await this.openaiStreamChatCompletion(config, messages, options, reply);
  }

  private async openaiStreamChatCompletion(
    config: LiteLLMConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    const client = this.getOpenAIClient(config);

    const requestParams: any = {
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.temperature !== undefined) requestParams.temperature = options.temperature;
    if (options.max_tokens !== undefined) requestParams.max_tokens = options.max_tokens;
    if (options.top_p !== undefined) requestParams.top_p = options.top_p;
    if (options.frequency_penalty !== undefined) requestParams.frequency_penalty = options.frequency_penalty;
    if (options.presence_penalty !== undefined) requestParams.presence_penalty = options.presence_penalty;
    if (options.stop !== undefined) requestParams.stop = options.stop;
    if (options.n !== undefined) requestParams.n = options.n;
    if (options.tools !== undefined) requestParams.tools = options.tools;
    if (options.tool_choice !== undefined) requestParams.tool_choice = options.tool_choice;
    if (options.response_format !== undefined) requestParams.response_format = options.response_format;
    if (options.seed !== undefined) requestParams.seed = options.seed;

    const stream = await client.chat.completions.create(requestParams);

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
          thinkingBlocks
        );
        reasoningContent = extraction.reasoningContent;
        thinkingBlocks = extraction.thinkingBlocks as ThinkingBlock[];
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
    config: LiteLLMConfig,
    messages: any[],
    options: any,
    reply: FastifyReply
  ): Promise<StreamTokenUsage> {
    const client = this.getAnthropicClient(config);
    const { system, messages: anthropicMessages } = this.convertToAnthropicFormat(messages);

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
}

