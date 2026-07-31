import { FastifyReply } from 'fastify';
import { ProtocolAdapter, type ProtocolConfig } from '../../services/protocol-adapter.js';
import { stripFieldRecursively } from '../../utils/request-logger.js';
import { normalizeOpenAIError } from '../../utils/http-error-normalizer.js';
import { upstreamFetch } from '../../utils/upstream-fetch.js';
import { sanitizeCustomHeaders, filterForwardedHeaders } from '../../utils/header-sanitizer.js';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: any;
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
  tffbMs?: number;
  reasoningContent?: string;
  thinkingBlocks?: ThinkingBlock[];
}

export interface RequestOptions {
  messages?: any[];
  options?: any;
  input?: string | string[] | any[];
  isEmbeddingsRequest?: boolean;
  isResponsesRequest?: boolean;
  isResponsesCompactRequest?: boolean;
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

/**
 * 提取上游 SDK 错误的原始 HTTP status 与 body，绕过 normalizeOpenAIError 的改写。
 * 用于模型后缀强制 reasoning_effort 场景下的错误原样透传。
 */
function extractRawUpstreamError(error: any): { statusCode: number; errorResponse: any } {
  const statusCode = typeof error?.status === 'number'
    ? error.status
    : typeof error?.statusCode === 'number'
      ? error.statusCode
      : 500;

  const rawBody = error?.error ?? error?.errorResponse ?? null;
  const errorResponse = rawBody && typeof rawBody === 'object'
    ? rawBody
    : {
        error: {
          message: error?.message || 'Upstream request failed',
          type: 'api_error',
          param: null,
          code: 'upstream_error',
        },
      };

  return { statusCode, errorResponse };
}

export async function makeHttpRequest(
  config: ProtocolConfig,
  messages: any[],
  options: any,
  isEmbeddingsRequest: boolean = false,
  input?: string | string[],
  isResponsesRequest: boolean = false,
  abortSignal?: AbortSignal,
  isResponsesCompactRequest: boolean = false
): Promise<HttpResponse> {
  try {
    let response: any;

    if (isEmbeddingsRequest) {
      response = await protocolAdapter.createEmbedding(config, input || [], options, abortSignal);
    } else if (isResponsesCompactRequest) {
      response = await protocolAdapter.compactResponse(config, input || [], options, abortSignal);
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
      body: response
    };
  } catch (error: any) {
    const { statusCode, errorResponse } = (options as any)?.__skipErrorNormalization
      ? extractRawUpstreamError(error)
      : normalizeError(error);

    return {
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: errorResponse
    };
  }
}

/**
 * Build an OpenAI-compatible upstream URL, de-duplicating /v1 when both baseUrl and path contain it.
 */
export function buildOpenAICompatibleUrl(baseUrl: string | undefined, path: string): string {
  const trimmedBase = (baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (!trimmedBase) {
    return normalizedPath;
  }

  const baseEndsWithV1 = /\/v1$/i.test(trimmedBase);
  const pathStartsWithV1 = normalizedPath.toLowerCase().startsWith('/v1/');

  if (baseEndsWithV1 && pathStartsWithV1) {
    return `${trimmedBase}${normalizedPath.slice(3)}`;
  }

  return `${trimmedBase}${normalizedPath}`;
}

export async function makeImageGenerationProxyRequest(
  config: ProtocolConfig,
  path: string,
  body: any,
  forwardedHeaders: Record<string, string>,
  abortSignal?: AbortSignal
): Promise<HttpResponse> {
  const url = buildOpenAICompatibleUrl(config.baseUrl, path);

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  const modelAttributeHeaders = sanitizeCustomHeaders(config.modelAttributes?.headers);
  if (modelAttributeHeaders) {
    Object.assign(headers, modelAttributeHeaders);
  }

  const filteredForwarded = filterForwardedHeaders(config.modelAttributes?.headers, forwardedHeaders);
  if (filteredForwarded) {
    Object.assign(headers, filteredForwarded);
  }

  try {
    const response = await upstreamFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    const responseBody = await response.text();
    const responseHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let parsedBody: any;
    const contentType = String(responseHeaders['content-type'] || '').toLowerCase();
    if (contentType.includes('application/json') && responseBody) {
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        parsedBody = responseBody;
      }
    } else {
      parsedBody = responseBody;
    }

    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: parsedBody,
    };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw error;
    }

    const norm = normalizeOpenAIError(error);
    return {
      statusCode: norm.statusCode,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          message: norm.message,
          type: norm.errorType,
          param: null,
          code: norm.errorCode,
        },
      },
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
    const { statusCode, errorResponse } = (options as any)?.__skipErrorNormalization
      ? extractRawUpstreamError(error)
      : normalizeError(error);
    // 不直接向客户端写入错误，交由上层决定是否重试或返回
    const enriched = new Error(errorResponse?.error?.message || 'Stream request failed');
    (enriched as any).statusCode = statusCode;
    (enriched as any).errorResponse = errorResponse;
    throw enriched;
  }
}
