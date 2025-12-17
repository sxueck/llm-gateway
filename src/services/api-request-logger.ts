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
  errorMessage?: unknown;
  truncatedRequest?: string;
  truncatedResponse?: string;
  cacheHit?: 0 | 1;
  cachedTokens?: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
  ip?: string;
  userAgent?: string;
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
    error_message: normalizedErrorMessage,
    request_body: params.truncatedRequest,
    response_body: params.truncatedResponse,
    cache_hit: params.cacheHit ?? 0,
    compression_original_tokens: params.compressionStats?.originalTokens,
    compression_saved_tokens: params.compressionStats?.savedTokens,
    ip: params.ip,
    user_agent: params.userAgent,
  });
}
