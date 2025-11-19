import { FastifyReply } from 'fastify';
import { ProtocolAdapter, type ProtocolConfig } from '../../services/protocol-adapter.js';
import OpenAI from 'openai';

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

export interface RequestOptions {
  messages?: any[];
  options?: any;
  input?: string | string[] | any[];
  isEmbeddingsRequest?: boolean;
  isResponsesRequest?: boolean;
  abortSignal?: AbortSignal;
}

const protocolAdapter = new ProtocolAdapter();

function normalizeError(error: any): { statusCode: number; errorResponse: any } {
  let statusCode = 500;
  let errorType = 'api_error';
  let errorCode = 'llm_error';
  let message = error.message || 'LLM 请求失败';

  // 处理 OpenAI SDK 特定错误
  if (error instanceof OpenAI.APIError) {
    statusCode = error.status || 500;
    message = error.message;
    
    // 记录 requestID 用于调试
    if (error.requestID) {
      message += ` (Request ID: ${error.requestID})`;
    }
  } else if (error instanceof OpenAI.APIUserAbortError) {
    statusCode = 499; // Client Closed Request
    errorType = 'request_cancelled';
    errorCode = 'user_aborted';
    message = '请求已被取消';
  } else if (error.status) {
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
  config: ProtocolConfig,
  messages: any[],
  options: any,
  isEmbeddingsRequest: boolean = false,
  input?: string | string[],
  isResponsesRequest: boolean = false,
  abortSignal?: AbortSignal
): Promise<HttpResponse> {
  try {
    let response: any;

    if (isEmbeddingsRequest) {
      response = await protocolAdapter.createEmbedding(config, input || [], options, abortSignal);
    } else if (isResponsesRequest) {
      response = await protocolAdapter.createResponse(config, input || '', options, abortSignal);
    } else {
      response = await protocolAdapter.chatCompletion(config, messages, options, abortSignal);
    }

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
  config: ProtocolConfig,
  messages: any[],
  options: any,
  reply: FastifyReply,
  input?: string | any[],
  isResponsesRequest: boolean = false,
  abortSignal?: AbortSignal
): Promise<StreamTokenUsage> {
  try {
    if (isResponsesRequest) {
      return await protocolAdapter.streamResponse(config, input || '', options, reply, abortSignal);
    }
    return await protocolAdapter.streamChatCompletion(config, messages, options, reply, abortSignal);
  } catch (error: any) {
    const { statusCode, errorResponse } = normalizeError(error);
    // 不直接向客户端写入错误，交由上层决定是否重试或返回
    const enriched = new Error(errorResponse?.error?.message || 'Stream request failed');
    (enriched as any).statusCode = statusCode;
    (enriched as any).errorResponse = errorResponse;
    throw enriched;
  }
}

