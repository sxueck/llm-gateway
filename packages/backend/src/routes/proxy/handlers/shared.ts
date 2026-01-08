import { truncateRequestBody, truncateResponseBody, buildFullRequestBody } from '../../../utils/request-logger.js';
import type { VirtualKey } from '../../../types/index.js';

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
