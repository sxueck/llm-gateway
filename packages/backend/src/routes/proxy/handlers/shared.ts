import { truncateRequestBody, truncateResponseBody, buildFullRequestBody } from '../../../utils/request-logger.js';
import type { VirtualKey } from '../../../types/index.js';

const SHARED_OPTIONS = [
  'temperature', 'top_p', 'store', 'stream_options', 'service_tier',
  'safety_identifier', 'prompt_cache_key', 'tools', 'tool_choice',
  'parallel_tool_calls', 'thinking',
] as const;

function extractSharedRequestOptions(body: any): Record<string, any> {
  const options: Record<string, any> = {};
  for (const key of SHARED_OPTIONS) {
    if (body?.[key] !== undefined) options[key] = body[key];
  }
  return options;
}

export function extractChatCompletionOptions(body: any): Record<string, any> {
  return {
    ...extractSharedRequestOptions(body),
    max_tokens: body?.max_tokens,
    max_completion_tokens: body?.max_completion_tokens,
    frequency_penalty: body?.frequency_penalty,
    presence_penalty: body?.presence_penalty,
    stop: body?.stop,
    response_format: body?.response_format,
    reasoning_effort: body?.reasoning_effort,
    verbosity: body?.verbosity,
    user: body?.user,
  };
}

export function extractResponsesApiOptions(body: any): Record<string, any> {
  return {
    ...extractSharedRequestOptions(body),
    instructions: body?.instructions,
    metadata: body?.metadata,
    mcp: body?.mcp,
    reasoning: body?.reasoning,
    text: body?.text,
    truncation: body?.truncation,
    user: body?.user,
    include: body?.include,
    previous_response_id: body?.previous_response_id,
    max_tool_calls: body?.max_tool_calls,
    background: body?.background,
    conversation: body?.conversation,
  };
}

export function shouldLogRequestBody(virtualKey: VirtualKey): boolean {
  return !virtualKey.disable_logging;
}

export function buildFullRequest(requestBody: any, currentModel?: any): any {
  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch (e) {
    }
  }
  return buildFullRequestBody(requestBody, modelAttributes);
}

/**
 * 统一获取用于日志的模型名称
 *
 * - 对于虚拟模型/智能路由：优先记录最终解析到的真实模型（currentModel）
 * - 否则回退到请求体中的 model 字段
 */
export function getModelForLogging(requestBody: any, currentModel?: any): string {
  const resolvedModel = currentModel?.model_identifier || currentModel?.name;
  const requestedModel = requestBody && typeof requestBody === 'object' ? (requestBody as any).model : undefined;
  return resolvedModel || requestedModel || 'unknown';
}

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
