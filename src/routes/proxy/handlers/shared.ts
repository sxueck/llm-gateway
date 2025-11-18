import { nanoid } from 'nanoid';
import { apiRequestDb } from '../../../db/index.js';
import { truncateRequestBody, truncateResponseBody, buildFullRequestBody } from '../../../utils/request-logger.js';
import type { VirtualKey } from '../../../types/index.js';
import type { TokenCalculationResult } from '../token-calculator.js';

/**
 * 判断是否应该记录请求体
 */
export function shouldLogRequestBody(virtualKey: VirtualKey): boolean {
  return !virtualKey.disable_logging;
}

/**
 * 构建完整请求体参数（包含模型属性）
 */
export function buildFullRequest(requestBody: any, currentModel?: any): any {
  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch (e) {
      // 忽略解析错误
    }
  }
  return buildFullRequestBody(requestBody, modelAttributes);
}

/**
 * 获取截断后的请求和响应体
 */
export function getTruncatedBodies(
  requestBody: any,
  responseBody: any,
  virtualKey: VirtualKey,
  currentModel?: any
): { truncatedRequest?: string; truncatedResponse?: string } {
  const shouldLogBody = shouldLogRequestBody(virtualKey);
  if (!shouldLogBody) {
    return { truncatedRequest: undefined, truncatedResponse: undefined };
  }

  const fullRequestBody = buildFullRequest(requestBody, currentModel);
  const truncatedRequest = truncateRequestBody(fullRequestBody);
  const truncatedResponse = truncateResponseBody(responseBody);

  return { truncatedRequest, truncatedResponse };
}

/**
 * 记录API请求到数据库
 */
export async function logApiRequest(params: {
  virtualKey: VirtualKey;
  providerId: string;
  requestBody: any;
  tokenCount: TokenCalculationResult;
  status: 'success' | 'error';
  responseTime: number;
  errorMessage?: string;
  truncatedRequest?: string;
  truncatedResponse?: string;
  cacheHit?: number;
  compressionStats?: { originalTokens: number; savedTokens: number };
}): Promise<void> {
  await apiRequestDb.create({
    id: nanoid(),
    virtual_key_id: params.virtualKey.id,
    provider_id: params.providerId,
    model: (params.requestBody as any)?.model || 'unknown',
    prompt_tokens: params.tokenCount.promptTokens,
    completion_tokens: params.tokenCount.completionTokens,
    total_tokens: params.tokenCount.totalTokens,
    status: params.status,
    response_time: params.responseTime,
    error_message: params.errorMessage,
    request_body: params.truncatedRequest,
    response_body: params.truncatedResponse,
    cache_hit: params.cacheHit ?? 0,
    compression_original_tokens: params.compressionStats?.originalTokens,
    compression_saved_tokens: params.compressionStats?.savedTokens,
  });
}