import type { AnthropicRequest } from '../types/anthropic.js';

/**
 * Models that only support adaptive thinking. On these models, setting
 * sampling parameters (temperature/top_p/top_k) to a non-default value and
 * manual extended thinking (`{type: "enabled", budget_tokens}`) both return
 * HTTP 400. See the Claude model migration guides.
 */
const ADAPTIVE_ONLY_MODEL_PATTERNS = [
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-mythos-5',
];

function isAdaptiveOnlyModel(model: string): boolean {
  const lower = model.toLowerCase();
  return ADAPTIVE_ONLY_MODEL_PATTERNS.some(pattern => lower.includes(pattern));
}

function isSonnet5(model: string): boolean {
  return model.toLowerCase().includes('claude-sonnet-5');
}

function isSonnetWithAdaptiveThinking(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('claude-sonnet-5') || lower.includes('claude-sonnet-4-6');
}

export function normalizeAnthropicRequest(
  model: string,
  request: AnthropicRequest
): AnthropicRequest {
  const adaptiveOnlyModel = isAdaptiveOnlyModel(model);
  const sonnetWithAdaptiveThinking = isSonnetWithAdaptiveThinking(model);
  if (!adaptiveOnlyModel && !sonnetWithAdaptiveThinking) {
    return request;
  }

  let normalized: AnthropicRequest = request;

  if (normalized.thinking?.type === 'enabled') {
    normalized = { ...normalized, thinking: { type: 'adaptive' } };
  }

  if (adaptiveOnlyModel && (
    normalized.temperature !== undefined ||
    normalized.top_p !== undefined ||
    normalized.top_k !== undefined
  )) {
    const { temperature, top_p, top_k, ...rest } = normalized;
    normalized = rest;
  }

  if (isSonnet5(model)) {
    if (normalized.thinking === undefined) {
      normalized = { ...normalized, thinking: { type: 'adaptive', display: 'summarized' } };
    }
  }

  if (sonnetWithAdaptiveThinking && normalized.thinking?.type === 'adaptive' && normalized.thinking.display === undefined) {
    normalized = { ...normalized, thinking: { ...normalized.thinking, display: 'summarized' } };
  }

  return normalized;
}
