import { nanoid } from 'nanoid';
import { apiRequestDb } from '../db/index.js';
import type { VirtualKey } from '../types/index.js';
import type { TokenCalculationResult } from '../routes/proxy/token-calculator.js';

/**
 * 统一的 API 请求日志写库工具
 *
 * 所有写入 api_requests 表的逻辑都应该通过这里进行，避免在各个 handler 中手动拼字段。
 */
export interface ApiLogParams {
  virtualKey: VirtualKey;
  providerId: string;
  model: string;
  tokenCount: TokenCalculationResult; // { promptTokens, completionTokens, totalTokens }
  status: 'success' | 'error';
  responseTime: number;
  tfftMs?: number;
  errorMessage?: unknown;
  truncatedRequest?: string;
  truncatedResponse?: string;
  cacheHit?: 0 | 1;
  cachedTokens?: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  ip?: string;
  userAgent?: string;
}

function safeParseJson(text: string | undefined): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function extractRequestParamsJson(requestBody: string | undefined): string | undefined {
  const parsed = safeParseJson(requestBody);
  if (!parsed || typeof parsed !== 'object') return undefined;

  const params = compactObject({
    temperature: parsed.temperature,
    top_p: parsed.top_p,
    max_tokens: parsed.max_tokens ?? parsed.max_completion_tokens,
    stream: parsed.stream,
    tool_choice: parsed.tool_choice,
    tools_count: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
    reasoning_effort: parsed.reasoning?.effort,
    user: parsed.user,
  });

  if (Object.keys(params).length === 0) return undefined;
  return JSON.stringify(params);
}

function extractResponseMetaJson(responseBody: string | undefined): string | undefined {
  const parsed = safeParseJson(responseBody);
  if (!parsed || typeof parsed !== 'object') return undefined;

  const usage = parsed.usage ?? {};
  const finishReason = parsed.choices?.[0]?.finish_reason;
  const meta = compactObject({
    status: parsed.status,
    finish_reason: finishReason,
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
    cached_tokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
  });

  if (Object.keys(meta).length === 0) return undefined;
  return JSON.stringify(meta);
}

function normalizeErrorMessage(errorMessage: unknown): string | undefined {
  if (errorMessage === undefined || errorMessage === null) {
    return undefined;
  }

  if (typeof errorMessage === 'string') {
    return errorMessage;
  }

  try {
    return JSON.stringify(errorMessage);
  } catch (_e) {
    return String(errorMessage);
  }
}

export async function logApiRequestToDb(params: ApiLogParams): Promise<void> {
  const normalizedErrorMessage = normalizeErrorMessage(params.errorMessage);
  const requestParamsJson = extractRequestParamsJson(params.truncatedRequest);
  const responseMetaJson = extractResponseMetaJson(params.truncatedResponse);

  await apiRequestDb.create({
    id: nanoid(),
    virtual_key_id: params.virtualKey.id,
    provider_id: params.providerId,
    model: params.model || 'unknown',
    prompt_tokens: params.tokenCount.promptTokens,
    completion_tokens: params.tokenCount.completionTokens,
    total_tokens: params.tokenCount.totalTokens,
    cached_tokens: params.cachedTokens,
    status: params.status,
    response_time: params.responseTime,
    tfft_ms: params.tfftMs,
    error_message: normalizedErrorMessage,
    request_body: params.truncatedRequest,
    response_body: params.truncatedResponse,
    request_params_json: requestParamsJson,
    response_meta_json: responseMetaJson,
    cache_hit: params.cacheHit ?? 0,
    compression_original_tokens: params.compressionStats?.originalTokens,
    compression_saved_tokens: params.compressionStats?.savedTokens,
    ip: params.ip,
    user_agent: params.userAgent,
  });
}
