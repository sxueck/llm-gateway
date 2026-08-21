/**
 * Per-model serving limits.
 *
 * `max_completion_tokens` in model_attributes is the serving truth — the value this
 * relay will actually accept and forward. It is either configured by the operator or
 * sourced from an upstream /v1/models entry. Catalog/lab numbers (models.dev-style
 * `max_tokens` / `max_output_tokens`) are NOT serving caps and must never be used to
 * clamp requests or advertise limits to clients.
 */

export interface ServingLimits {
  /** Total context window (input + output), if known. */
  contextWindow?: number;
  /** Upstream serving cap on generated completion tokens, if known. */
  maxCompletionTokens?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function resolveServingLimits(modelAttributes: any): ServingLimits {
  if (!modelAttributes || typeof modelAttributes !== "object") {
    return {};
  }

  return {
    contextWindow:
      toFiniteNumber(modelAttributes.context_window) ??
      toFiniteNumber(modelAttributes.context_length) ??
      // litellm-style presets store the context window in max_tokens
      toFiniteNumber(modelAttributes.max_tokens),
    maxCompletionTokens: toFiniteNumber(modelAttributes.max_completion_tokens),
  };
}

/**
 * Clamp chat-style max token request fields (max_tokens / max_completion_tokens)
 * in place to the serving cap. Returns true when any field was rewritten.
 */
export function clampMaxTokensFields(
  body: any,
  cap: number | undefined,
): boolean {
  const limit = toFiniteNumber(cap);
  if (!body || typeof body !== "object" || limit === undefined) {
    return false;
  }

  let clamped = false;
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value) && value > limit) {
      body[field] = limit;
      clamped = true;
    }
  }
  return clamped;
}
