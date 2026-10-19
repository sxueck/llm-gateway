/**
 * Anthropic usage merging for streaming responses.
 *
 * Anthropic-compatible providers differ in where usage fields appear:
 * some (e.g. GLM via /v1/messages) report zeros in message_start and only
 * return the real input/cache/output counts in the final message_delta.
 * Usage fields are cumulative snapshots, so reports must be merged
 * field-wise — a later report overwrites, never accumulates.
 */

export interface AnthropicUsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function createEmptyAnthropicUsage(): AnthropicUsageCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/** Valid token count per protocol semantics: a finite non-negative number (0 included). */
function sanitizeTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Merge one usage report (from message_start.message.usage or
 * message_delta.usage) into the accumulated counts. A missing, invalid
 * (NaN/negative/non-number) field keeps the previous value; an explicit
 * valid 0 overwrites it — both are protocol-meaningful, so truthiness
 * checks must not be used.
 */
export function mergeAnthropicUsage(
  base: AnthropicUsageCounts,
  incoming: unknown,
): AnthropicUsageCounts {
  if (!incoming || typeof incoming !== "object") return base;
  const usage = incoming as Record<string, unknown>;
  const inputTokens = sanitizeTokenCount(usage.input_tokens);
  const outputTokens = sanitizeTokenCount(usage.output_tokens);
  const cacheCreationInputTokens = sanitizeTokenCount(
    usage.cache_creation_input_tokens,
  );
  const cacheReadInputTokens = sanitizeTokenCount(
    usage.cache_read_input_tokens,
  );
  return {
    inputTokens: inputTokens ?? base.inputTokens,
    outputTokens: outputTokens ?? base.outputTokens,
    cacheCreationInputTokens:
      cacheCreationInputTokens ?? base.cacheCreationInputTokens,
    cacheReadInputTokens: cacheReadInputTokens ?? base.cacheReadInputTokens,
  };
}

/** Billing input per gateway convention: base input + cache creation + cache read. */
export function anthropicPromptTokens(usage: AnthropicUsageCounts): number {
  return (
    usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  );
}
