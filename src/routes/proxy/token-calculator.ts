import { countStreamResponseTokens, countRequestTokens } from '../../services/token-counter.js';

/**
 * Token计算结果
 */
export interface TokenCalculationResult {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 统一的Token计算函数
 * 
 * 支持 OpenAI Chat Completions 和 Responses API 的token计算
 * 优先级：
 * 1. 流中解析的usage
 * 2. 响应body中的usage（归一化处理）
 * 3. Fallback计算
 * 
 * @param totalTokens - 总token数（如果已知）
 * @param requestBody - 请求体
 * @param responseBody - 响应体（可选）
 * @param streamChunks - 流式响应块（可选）
 * @param promptTokensFromStream - 从流中解析的prompt tokens
 * @param completionTokensFromStream - 从流中解析的completion tokens
 */
export async function calculateTokensIfNeeded(
  totalTokens: number,
  requestBody: any,
  responseBody?: any,
  streamChunks?: string[],
  promptTokensFromStream?: number,
  completionTokensFromStream?: number
): Promise<TokenCalculationResult> {
  // 优先使用从流中解析的 usage 信息
  if (promptTokensFromStream !== undefined && completionTokensFromStream !== undefined) {
    return {
      promptTokens: promptTokensFromStream,
      completionTokens: completionTokensFromStream,
      totalTokens: promptTokensFromStream + completionTokensFromStream
    };
  }

  // 优先使用响应中的 usage 信息（即使 totalTokens 为 0）
  if (responseBody?.usage) {
    const usage: any = responseBody.usage;

    // 归一化 OpenAI Responses 与 Chat Completions 的用量字段
    const promptTokensBase = (usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completionTokens = (usage.completion_tokens ?? usage.output_tokens ?? 0);
    const computedTotal =
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : (promptTokensBase + completionTokens);
    
    // Anthropic 缓存用量字段（可能存在）
    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;

    // OpenAI Responses 缓存细节字段（通常 input_tokens 已包含 cached_tokens，这里仅在基础为 0 时兜底）
    const openaiCached =
      typeof usage?.input_tokens_details?.cached_tokens === 'number'
        ? usage.input_tokens_details.cached_tokens
        : (typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
          ? usage.prompt_tokens_details.cached_tokens
          : 0);

    // 仅在基础为 0 的情况下合并缓存，避免潜在的重复计数
    const promptTokens = promptTokensBase === 0
      ? (promptTokensBase + cacheCreation + cacheRead + openaiCached)
      : promptTokensBase;

    return { promptTokens, completionTokens, totalTokens: computedTotal };
  }

  if (totalTokens !== 0) {
    // 如果只有 total_tokens，需要 fallback 计算
    if (streamChunks) {
      return await countStreamResponseTokens(requestBody, streamChunks);
    }

    const calculated = await countRequestTokens(requestBody, responseBody);
    return {
      promptTokens: calculated.promptTokens,
      completionTokens: calculated.completionTokens,
      totalTokens
    };
  }

  if (streamChunks) {
    return await countStreamResponseTokens(requestBody, streamChunks);
  }

  return await countRequestTokens(requestBody, responseBody);
}