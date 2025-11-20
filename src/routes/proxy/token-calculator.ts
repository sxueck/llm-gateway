import { countStreamResponseTokens, countRequestTokens } from '../../services/token-counter.js';
import { memoryLogger } from '../../services/logger.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';

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
  // 优先使用从流中解析的 usage 信息；仅当两者之和大于 0 时才直接采用，
  // 否则回退到响应 usage 或本地估算，避免 0/0 提前返回导致不计入总量
  if (promptTokensFromStream !== undefined && completionTokensFromStream !== undefined) {
    const sum = (promptTokensFromStream || 0) + (completionTokensFromStream || 0);
    if (sum > 0) {
      memoryLogger.debug(`TokenCalc: using stream usage | prompt=${promptTokensFromStream} completion=${completionTokensFromStream} total=${sum}`, 'Token');
      return {
        promptTokens: promptTokensFromStream,
        completionTokens: completionTokensFromStream,
        totalTokens: sum
      };
    }
  }

  // 优先使用响应中的 usage 信息（即使 totalTokens 为 0）
  if (responseBody?.usage) {
    const norm = normalizeUsageCounts(responseBody.usage);
    memoryLogger.debug(`TokenCalc: using response usage | prompt=${norm.promptTokens} completion=${norm.completionTokens} total=${norm.totalTokens}`, 'Token');
    return { promptTokens: norm.promptTokens, completionTokens: norm.completionTokens, totalTokens: norm.totalTokens };
  }

  if (totalTokens !== 0) {
    // 如果只有 total_tokens，需要 fallback 计算
    if (streamChunks) {
      const counted = await countStreamResponseTokens(requestBody, streamChunks);
      memoryLogger.debug(`TokenCalc: fallback stream count with provided total | prompt=${counted.promptTokens} completion=${counted.completionTokens} total=${totalTokens}`, 'Token');
      return { promptTokens: counted.promptTokens, completionTokens: counted.completionTokens, totalTokens };
    }

    const calculated = await countRequestTokens(requestBody, responseBody);
    memoryLogger.debug(`TokenCalc: fallback non-stream with provided total | prompt=${calculated.promptTokens} completion=${calculated.completionTokens} total=${totalTokens}`, 'Token');
    return {
      promptTokens: calculated.promptTokens,
      completionTokens: calculated.completionTokens,
      totalTokens
    };
  }

  if (streamChunks) {
    const counted = await countStreamResponseTokens(requestBody, streamChunks);
    memoryLogger.debug(`TokenCalc: counted from stream chunks | prompt=${counted.promptTokens} completion=${counted.completionTokens} total=${counted.totalTokens}`, 'Token');
    return counted;
  }

  const counted = await countRequestTokens(requestBody, responseBody);
  memoryLogger.debug(`TokenCalc: counted from request/response | prompt=${counted.promptTokens} completion=${counted.completionTokens} total=${counted.totalTokens}`, 'Token');
  return counted;
}