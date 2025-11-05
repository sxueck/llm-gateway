import { FastifyReply } from 'fastify';
import { LiteLLMAdapter, type LiteLLMConfig } from '../../services/litellm-adapter.js';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface ThinkingBlock {
  type: string;
  thinking: string;
  signature?: string;
}

export interface StreamTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamChunks: string[];
  reasoningContent?: string;
  thinkingBlocks?: ThinkingBlock[];
}

const litellmAdapter = new LiteLLMAdapter();

function normalizeError(error: any): { statusCode: number; errorResponse: any } {
  let statusCode = 500;
  let errorType = 'api_error';
  let errorCode = 'llm_error';
  let message = error.message || 'LLM 请求失败';

  if (error.status) {
    statusCode = error.status;
  }

  if (statusCode === 401) {
    errorType = 'authentication_error';
    errorCode = 'invalid_api_key';
  } else if (statusCode === 429) {
    errorType = 'rate_limit_error';
    errorCode = 'rate_limit_exceeded';
  } else if (statusCode === 400) {
    errorType = 'invalid_request_error';
    errorCode = 'invalid_request';
  } else if (statusCode >= 500) {
    errorType = 'api_error';
    errorCode = 'internal_server_error';
  }

  return {
    statusCode,
    errorResponse: {
      error: {
        message,
        type: errorType,
        param: null,
        code: errorCode
      }
    }
  };
}

export async function makeHttpRequest(
  config: LiteLLMConfig,
  messages: any[],
  options: any
): Promise<HttpResponse> {
  try {
    const response = await litellmAdapter.chatCompletion(config, messages, options);

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

export async function makeStreamHttpRequest(
  config: LiteLLMConfig,
  messages: any[],
  options: any,
  reply: FastifyReply
): Promise<StreamTokenUsage> {
  try {
    return await litellmAdapter.streamChatCompletion(config, messages, options, reply);
  } catch (error: any) {
    const { statusCode, errorResponse } = normalizeError(error);

    reply.raw.writeHead(statusCode, {
      'Content-Type': 'application/json',
    });

    reply.raw.write(JSON.stringify(errorResponse));
    reply.raw.end();

    throw error;
  }
}

