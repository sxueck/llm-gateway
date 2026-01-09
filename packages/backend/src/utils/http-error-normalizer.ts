import OpenAI from 'openai';

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
