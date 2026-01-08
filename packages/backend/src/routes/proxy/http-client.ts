import { FastifyReply } from 'fastify';
import { ProtocolAdapter, type ProtocolConfig } from '../../services/protocol-adapter.js';
import { stripFieldRecursively } from '../../utils/request-logger.js';
import { normalizeOpenAIError } from '../../utils/http-error-normalizer.js';

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
  cachedTokens: number;
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
  const norm = normalizeOpenAIError(error);

  return {
    statusCode: norm.statusCode,
    errorResponse: {
      error: {
        message: norm.message,
        type: norm.errorType,
        param: null,
        code: norm.errorCode,
      },
    },
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

    try {
      stripFieldRecursively(response, 'instructions');
    } catch (_e) {
      // Ignore strip errors
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

