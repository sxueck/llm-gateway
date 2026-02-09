import OpenAI from 'openai';

const MAX_ERROR_MESSAGE_LENGTH = 600;

function isLikelyHtmlErrorPage(message: string): boolean {
  // Match full HTML pages (or common "HTTP 403: <html..." wrappers) only when the payload starts like HTML.
  return /^(?:http\s*\d{3}\s*:?\s*)?(?:<!doctype html|<html[\s>])/i.test(message);
}

function sanitizeUpstreamMessage(rawMessage: string, statusCode: number): string {
  const normalized = String(rawMessage || '').replace(/\s+/g, ' ').trim();
  const looksLikeHtml = isLikelyHtmlErrorPage(normalized);

  if (looksLikeHtml) {
    if (statusCode === 403) {
      return 'Upstream access denied by security policy (possible Cloudflare/WAF block)';
    }
    return `Upstream returned an HTML error page (HTTP ${statusCode})`;
  }

  if (normalized.length > MAX_ERROR_MESSAGE_LENGTH) {
    return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
  }

  return normalized || 'LLM 请求失败';
}

export interface NormalizedLlmError {
  statusCode: number;
  errorType: string;
  message: string;
  errorCode?: string;
}

/**
 * 统一的 LLM 错误归一化工具
 * - 提取 http status、错误类型与消息
 * - 上层再根据需要组装 errorResponse 结构
 */
export function normalizeOpenAIError(error: any): NormalizedLlmError {
  let statusCode = 500;
  let errorType = 'api_error';
  let errorCode = 'llm_error';
  let message = error?.message || 'LLM 请求失败';

  // 处理 OpenAI SDK 特定错误
  if (error instanceof OpenAI.APIError) {
    const apiError = error as any;
    statusCode = typeof apiError.status === 'number' ? apiError.status : 500;
    message = apiError.message;

    // 记录 requestID 用于调试（如果存在）
    if (apiError.requestID) {
      message += ` (Request ID: ${apiError.requestID})`;
    }
  } else if (error instanceof OpenAI.APIUserAbortError) {
    statusCode = 499; // Client Closed Request
    errorType = 'request_cancelled';
    errorCode = 'user_aborted';
    message = '请求已被取消';
  } else if (error && typeof error === 'object' && 'status' in error && typeof (error as any).status === 'number') {
    statusCode = (error as any).status;
  }

  if (statusCode === 401) {
    errorType = 'authentication_error';
    errorCode = 'invalid_api_key';
  } else if (statusCode === 403) {
    errorType = 'permission_error';
    errorCode = 'access_denied';
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

  message = sanitizeUpstreamMessage(message, statusCode);

  return {
    statusCode,
    errorType,
    errorCode,
    message,
  };
}

export function normalizeAnthropicError(error: any): NormalizedLlmError {
  let statusCode = 500;
  let errorType = 'api_error';
  let message = error?.message || 'Anthropic request failed';

  if (error && typeof error === 'object' && 'status' in error && typeof (error as any).status === 'number') {
    statusCode = (error as any).status;
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
    errorType,
    message,
  };
}
