/**
 * Usage normalizer: unify token counting across Responses and Chat Completions.
 * - Supports input_tokens/output_tokens and prompt_tokens/completion_tokens
 * - Prefers total_tokens when provided; otherwise sums prompt+completion
 * - Adds cached tokens (OpenAI) only when base is 0 to avoid double counting
 * - Anthropic Messages dialect (top-level cache_read/cache_creation_input_tokens):
 *   input_tokens EXCLUDES the cache fields, so prompt folds them in and cached means
 *   cache READ only — the exact numbers the streaming path already records via
 *   anthropicPromptTokens(); non-stream rows must match (fixes stream/non-stream
 *   accounting divergence for identical upstream usage).
 */

export interface NormalizedTokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export function normalizeUsageCounts(usage: any): NormalizedTokenCounts {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
  }

  let prompt = (typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0));

  const completion = (typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0));

  const openaiCached =
    (usage.input_tokens_details && typeof usage.input_tokens_details.cached_tokens === 'number')
      ? usage.input_tokens_details.cached_tokens
      : ((usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === 'number')
        ? usage.prompt_tokens_details.cached_tokens
        : 0);

  const anthropicCacheCreation = typeof usage.cache_creation_input_tokens === 'number'
    ? usage.cache_creation_input_tokens
    : 0;
  const anthropicCacheRead = typeof usage.cache_read_input_tokens === 'number'
    ? usage.cache_read_input_tokens
    : 0;

  const anthropicDialect =
    typeof usage.cache_creation_input_tokens === 'number' ||
    typeof usage.cache_read_input_tokens === 'number';

  if (anthropicDialect) {
    prompt = prompt + anthropicCacheCreation + anthropicCacheRead;
    return {
      promptTokens: prompt || 0,
      completionTokens: completion || 0,
      totalTokens: (prompt + completion) || 0,
      cachedTokens: anthropicCacheRead || 0,
    };
  }

  const totalCached = openaiCached;

  // Only add cached tokens when base is zero (defensive, avoid double counting)
  if (prompt === 0) {
    prompt = prompt + totalCached;
  }

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