import type { AnthropicRequest } from '../types/anthropic.js';

/**
 * Claude 5 protocol only. Every Claude model is treated as adaptive-thinking:
 * manual extended thinking (`{type: "enabled", budget_tokens}`) is converted
 * to `{type: "adaptive"}` and non-default sampling parameters are stripped,
 * both of which return HTTP 400 on these models. Upstreams that still expect
 * the legacy budget_tokens protocol are not supported through the gateway.
 */
const CLAUDE_MODEL_PATTERN = /(^|[^a-z])claude([^a-z]|$)/;

function matchesModelPattern(model: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => model.includes(pattern));
}

/**
 * Models on which adaptive thinking is always on and applies ONLY when the
 * `thinking` parameter is unset. Any `thinking` object carrying a `type`
 * (enabled/adaptive/disabled) is rejected by the API with HTTP 400, and
 * `thinking: {type: "disabled"}` is explicitly unsupported. Thinking depth is
 * controlled via `output_config.effort` instead.
 * See: introducing-claude-fable-5-and-claude-mythos-5.
 */
const THINKING_UNSET_ONLY_MODEL_PATTERNS = ['claude-fable-5', 'claude-mythos-5'];

export function normalizeAnthropicRequest(model: string, request: AnthropicRequest): AnthropicRequest {
  const normalizedModel = model.toLowerCase();
  if (!CLAUDE_MODEL_PATTERN.test(normalizedModel)) return request;

  let normalized = request;

  if (matchesModelPattern(normalizedModel, THINKING_UNSET_ONLY_MODEL_PATTERNS) && normalized.thinking !== undefined) {
    const { thinking: _thinking, ...rest } = normalized;
    normalized = rest;
  }

  if (normalized.thinking?.type === 'enabled') {
    const display = (normalized.thinking as { display?: 'summarized' | 'omitted' }).display;
    normalized = { ...normalized, thinking: { type: 'adaptive', ...(display ? { display } : {}) } };
  }

  if (normalized.temperature !== undefined || normalized.top_p !== undefined || normalized.top_k !== undefined) {
    const { temperature: _temperature, top_p: _topP, top_k: _topK, ...rest } = normalized;
    normalized = rest;
  }

  if (normalized.thinking?.type === 'adaptive' && normalized.thinking.display === undefined) {
    normalized = {
      ...normalized,
      thinking: { ...normalized.thinking, display: 'summarized' }
    };
  }

  return normalized;
}
