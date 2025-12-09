import { FastifyReply } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../../services/logger.js';
import type { AnthropicRequest, AnthropicStreamEvent } from '../../types/anthropic.js';
import { normalizeAnthropicError } from '../../utils/http-error-normalizer.js';
import { EmptyOutputError } from '../../errors/empty-output-error.js';
import { sanitizeCustomHeaders } from '../../utils/header-sanitizer.js';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface StreamTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamChunks: string[];
}

function getAnthropicClient(baseUrl: string | undefined, apiKey: string, headers?: Record<string, string>): Anthropic {
  const clientConfig: any = {
    apiKey,
    maxRetries: 0,
    timeout: 60000,
  };

  if (baseUrl) {
    clientConfig.baseURL = baseUrl;
  }

  // 添加自定义请求头支持
  const sanitizedHeaders = sanitizeCustomHeaders(headers);
  if (sanitizedHeaders && Object.keys(sanitizedHeaders).length > 0) {
    clientConfig.defaultHeaders = sanitizedHeaders;
    memoryLogger.debug(
      `添加自定义请求头 | headers: ${JSON.stringify(sanitizedHeaders)}`,
      'Anthropic'
    );
  }

  return new Anthropic(clientConfig);
}

function buildRequestParams(config: any, requestBody: AnthropicRequest, stream: boolean = false): any {
  const requestParams: any = {
    model: config.model,
    messages: requestBody.messages,
    max_tokens: requestBody.max_tokens,
  };

  if (stream) {
    requestParams.stream = true;
  }

  // 可选参数列表
  const optionalParams: Array<keyof AnthropicRequest> = [
    'system',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'metadata',
    'tool_choice',
  ];

  // 批量处理可选参数
  for (const param of optionalParams) {
    if (requestBody[param] !== undefined) {
      requestParams[param] = requestBody[param];
    }
  }

  // 特殊处理 tools 参数
  if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    requestParams.tools = requestBody.tools;
  }

  return requestParams;
}

function normalizeError(error: any): { statusCode: number; errorResponse: any } {
  const norm = normalizeAnthropicError(error);

  return {
    statusCode: norm.statusCode,
    errorResponse: {
      type: 'error',
      error: {
        type: norm.errorType,
        message: norm.message,
      },
    },
  };
}

const DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT = Math.max(
  parseInt(process.env.ANTHROPIC_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

function getAnthropicEmptyRetryLimit(config: any): number {
  const configured = config.modelAttributes?.anthropic_empty_retry_limit;
  if (typeof configured === 'number' && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT;
}

function hasAnthropicContent(event: AnthropicStreamEvent): boolean {
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return (event.delta.text || '').trim().length > 0;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    return true;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    return true;
  }
  return false;
}

export async function makeAnthropicRequest(
  config: any,
  requestBody: AnthropicRequest
): Promise<HttpResponse> {
  try {
    const headers = config.modelAttributes?.headers;
    const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);
    const requestParams = buildRequestParams(config, requestBody);
    const response = await client.messages.create(requestParams);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response)
    };
  } catch (error: any) {
    const { statusCode, errorResponse } = normalizeError(error);

    return {
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(errorResponse)
    };
  }
}

export async function makeAnthropicStreamRequest(
  config: any,
  requestBody: AnthropicRequest,
  reply: FastifyReply
): Promise<StreamTokenUsage> {
  const headers = config.modelAttributes?.headers;

  const totalAttempts = Math.max(1, getAnthropicEmptyRetryLimit(config) + 1);
  let lastEmptyError: EmptyOutputError | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);
    const requestParams = buildRequestParams(config, requestBody, true);

    try {
      const stream = client.messages.stream(requestParams);

      // 每次尝试都需要独立的变量，避免重试时状态混乱
      let inputTokens = 0;
      let cacheCreationInputTokens = 0;
      let cacheReadInputTokens = 0;
      let outputTokens = 0;
      let buffering = true;
      const pendingChunks: string[] = [];
      let hasAssistantContent = false;
      const streamChunks: string[] = [];

      const flushPendingChunks = () => {
        if (!buffering) return;
        buffering = false;
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
        }
        for (const chunk of pendingChunks) {
          reply.raw.write(chunk);
          streamChunks.push(chunk);
        }
        pendingChunks.length = 0;
      };

      const writeChunk = (chunk: string) => {
        if (buffering) {
          pendingChunks.push(chunk);
        } else {
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          }
          reply.raw.write(chunk);
          streamChunks.push(chunk);
        }
      };

      for await (const event of stream) {
        const eventData = event as AnthropicStreamEvent;

        if (!hasAssistantContent && hasAnthropicContent(eventData)) {
          hasAssistantContent = true;
          flushPendingChunks();
        }

        if (eventData.type === 'message_start') {
          if (eventData.message?.usage) {
            inputTokens = eventData.message.usage.input_tokens || 0;
            const anyUsage: any = eventData.message.usage as any;
            cacheCreationInputTokens = anyUsage?.cache_creation_input_tokens || 0;
            cacheReadInputTokens = anyUsage?.cache_read_input_tokens || 0;
          }
        } else if (eventData.type === 'message_delta') {
          const anyUsage: any = (eventData as any).usage;
          if (anyUsage && anyUsage.output_tokens !== undefined) {
            outputTokens = anyUsage.output_tokens as number;
          }
        }

        const sseData = `event: ${eventData.type}\ndata: ${JSON.stringify(eventData)}\n\n`;
        writeChunk(sseData);
      }

      // After stream completes, prefer SDK final snapshot usage for accuracy
      try {
        const finalMessage: any = await (stream as any).finalMessage?.();
        if (finalMessage?.usage) {
          inputTokens = finalMessage.usage.input_tokens ?? inputTokens;
          outputTokens = finalMessage.usage.output_tokens ?? outputTokens;
          cacheCreationInputTokens = finalMessage.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
          cacheReadInputTokens = finalMessage.usage.cache_read_input_tokens ?? cacheReadInputTokens;
        }
      } catch {}

       if (!hasAssistantContent) {
        if (attempt < totalAttempts) {
           memoryLogger.warn(
             `Anthropic 流式无实际输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
             'Anthropic'
           );
           lastEmptyError = new EmptyOutputError(
             'Anthropic stream completed without assistant output',
             { source: 'claude', attempt, totalAttempts }
           );
           continue;
        }
        
        flushPendingChunks();
        throw lastEmptyError || new EmptyOutputError(
          'Anthropic stream ended without assistant output',
          { source: 'claude', totalAttempts }
        );
      }

      flushPendingChunks();
      if (!reply.raw.writableEnded) {
          reply.raw.end();
      }

      const promptTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
      const completionTokens = outputTokens;

      return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        streamChunks,
      };

    } catch (error: any) {
      if (error instanceof EmptyOutputError) {
        if (!reply.raw.writableEnded) {
            reply.raw.end();
        }
        throw error;
      }

      memoryLogger.error(
        `Anthropic stream request failed: ${error.message}`,
        'Anthropic',
        { error: error.stack }
      );

      const { statusCode, errorResponse } = normalizeError(error);

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(statusCode, {
          'Content-Type': 'application/json',
        });
        const errorData = `data: ${JSON.stringify(errorResponse)}\n\n`;
        reply.raw.write(errorData);
        reply.raw.end();
      } else {
         if (!reply.raw.writableEnded) {
             const errorData = `event: error\ndata: ${JSON.stringify(errorResponse)}\n\n`;
             reply.raw.write(errorData);
             reply.raw.end();
         }
      }

      throw error;
    }
  }
  throw new Error('Anthropic stream retries exhausted');
}
