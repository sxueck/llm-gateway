import { FastifyReply } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../../services/logger.js';
import type { AnthropicRequest, AnthropicStreamEvent } from '../../types/anthropic.js';

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
  if (headers && Object.keys(headers).length > 0) {
    clientConfig.defaultHeaders = headers;
    memoryLogger.debug(
      `添加自定义请求头 | headers: ${JSON.stringify(headers)}`,
      'Anthropic'
    );
  }

  return new Anthropic(clientConfig);
}

function normalizeError(error: any): { statusCode: number; errorResponse: any } {
  let statusCode = 500;
  let errorType = 'api_error';
  let message = error.message || 'Anthropic request failed';

  if (error.status) {
    statusCode = error.status;
  }

  if (statusCode === 401) {
    errorType = 'authentication_error';
  } else if (statusCode === 429) {
    errorType = 'rate_limit_error';
  } else if (statusCode === 400) {
    errorType = 'invalid_request_error';
  } else if (statusCode === 404) {
    errorType = 'not_found_error';
  } else if (statusCode === 403) {
    errorType = 'permission_error';
  } else if (statusCode >= 500) {
    errorType = 'api_error';
  }

  return {
    statusCode,
    errorResponse: {
      type: 'error',
      error: {
        type: errorType,
        message,
      }
    }
  };
}

export async function makeAnthropicRequest(
  config: any,
  requestBody: AnthropicRequest
): Promise<HttpResponse> {
  try {
    const headers = config.modelAttributes?.headers;
    const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);

    const requestParams: any = {
      model: config.model,
      messages: requestBody.messages,
      max_tokens: requestBody.max_tokens,
    };

    if (requestBody.system) {
      requestParams.system = requestBody.system;
    }

    if (requestBody.temperature !== undefined) {
      requestParams.temperature = requestBody.temperature;
    }

    if (requestBody.top_p !== undefined) {
      requestParams.top_p = requestBody.top_p;
    }

    if (requestBody.top_k !== undefined) {
      requestParams.top_k = requestBody.top_k;
    }

    if (requestBody.stop_sequences !== undefined) {
      requestParams.stop_sequences = requestBody.stop_sequences;
    }

    if (requestBody.metadata !== undefined) {
      requestParams.metadata = requestBody.metadata;
    }

    if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
      requestParams.tools = requestBody.tools;
    }

    if (requestBody.tool_choice !== undefined) {
      requestParams.tool_choice = requestBody.tool_choice;
    }

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
  const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);

  const requestParams: any = {
    model: config.model,
    messages: requestBody.messages,
    max_tokens: requestBody.max_tokens,
    stream: true,
  };

  if (requestBody.system) {
    requestParams.system = requestBody.system;
  }

  if (requestBody.temperature !== undefined) {
    requestParams.temperature = requestBody.temperature;
  }

  if (requestBody.top_p !== undefined) {
    requestParams.top_p = requestBody.top_p;
  }

  if (requestBody.top_k !== undefined) {
    requestParams.top_k = requestBody.top_k;
  }

  if (requestBody.stop_sequences !== undefined) {
    requestParams.stop_sequences = requestBody.stop_sequences;
  }

  if (requestBody.metadata !== undefined) {
    requestParams.metadata = requestBody.metadata;
  }

  if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    requestParams.tools = requestBody.tools;
  }

  if (requestBody.tool_choice !== undefined) {
    requestParams.tool_choice = requestBody.tool_choice;
  }

  try {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const stream = client.messages.stream(requestParams);
 
    let inputTokens = 0;
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let outputTokens = 0;
    const streamChunks: string[] = [];

    for await (const event of stream) {
      const eventData = event as AnthropicStreamEvent;

      if (eventData.type === 'message_start') {
        if (eventData.message?.usage) {
          inputTokens = eventData.message.usage.input_tokens || 0;
          // Prompt caching usage (if present)
          // These keys are not always present; default to 0
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
      streamChunks.push(sseData);
      reply.raw.write(sseData);
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
 
    reply.raw.end();
 
    const promptTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const completionTokens = outputTokens;
 
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      streamChunks,
    };
  } catch (error: any) {
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
    }

    const errorData = `data: ${JSON.stringify(errorResponse)}\n\n`;
    reply.raw.write(errorData);
    reply.raw.end();

    throw error;
  }
}

