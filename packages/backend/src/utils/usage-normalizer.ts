/**
 * Usage normalizer: unify token counting across Responses and Chat Completions.
 * - Supports input_tokens/output_tokens and prompt_tokens/completion_tokens
 * - Prefers total_tokens when provided; otherwise sums prompt+completion
 * - Adds cached tokens (OpenAI and Anthropic) only when base is 0 to avoid double counting
 */

export interface NormalizedTokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

/**
 * Normalize heterogeneous usage objects into unified token counts.
 */
export function normalizeUsageCounts(usage: any): NormalizedTokenCounts {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
  }

  // Base prompt/input tokens
  let prompt = (typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0));

  // Completion/output tokens
  const completion = (typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0));

  // Cached tokens (OpenAI Responses)
  const openaiCached =
    (usage.input_tokens_details && typeof usage.input_tokens_details.cached_tokens === 'number')
      ? usage.input_tokens_details.cached_tokens
      : ((usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === 'number')
        ? usage.prompt_tokens_details.cached_tokens
        : 0);

  // Anthropic cache tokens
  const anthropicCacheCreation = typeof usage.cache_creation_input_tokens === 'number'
    ? usage.cache_creation_input_tokens
    : 0;
  const anthropicCacheRead = typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens
    : 0;

  // Total cached tokens (OpenAI + Anthropic)
  const totalCached = openaiCached + anthropicCacheCreation + anthropicCacheRead;

  // Only add cached tokens when base is zero (defensive, avoid double counting)
  if (prompt === 0) {
    prompt = prompt + totalCached;
  }

  // Total tokens: prefer provided value, else sum
  const total = (typeof usage.total_tokens === 'number')
    ? usage.total_tokens
    : (prompt + completion);

  return {
    promptTokens: prompt || 0,
    completionTokens: completion || 0,
    totalTokens: total || 0,
    cachedTokens: totalCached || 0,
  };
}