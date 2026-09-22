import type { AnthropicRequest } from '../types/anthropic.js';

/**
 * Models that only support adaptive thinking. On these models, setting
 * sampling parameters (temperature/top_p/top_k) to a non-default value and
 * manual extended thinking (`{type: "enabled", budget_tokens}`) both return
 * HTTP 400. See the Claude model migration guides.
 */
const ADAPTIVE_ONLY_MODEL_PATTERNS = ['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5', 'claude-mythos-5'];

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

const SONNET_WITH_ADAPTIVE_THINKING_PATTERNS = ['claude-sonnet-5', 'claude-sonnet-4-6'];

/**
 * Third-party Anthropic-compatible endpoints implement at most the core
 * thinking contract ({type, budget_tokens}). Forwarding newer Anthropic-only
 * sub-fields has caused real failures: one compat endpoint rendered
 * `display: "summarized"` as paraphrased reasoning copies in the text
 * channel. Unless the upstream model is Claude family, strip the thinking
 * object down to the core contract.
 */
function stripNonCoreThinkingForCompatModel(isClaudeModel: boolean, request: AnthropicRequest): AnthropicRequest {
  if (isClaudeModel) return request;
  const thinking = request.thinking as any;
  if (!thinking || typeof thinking !== 'object') return request;
  if (Object.keys(thinking).every(key => key === 'type' || key === 'budget_tokens')) return request;

  if (thinking.type === 'adaptive') return { ...request, thinking: { type: 'adaptive' } };
  if (thinking.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    return {
      ...request,
      thinking: { type: 'enabled', budget_tokens: thinking.budget_tokens }
    };
  }
  return request;
}

export function normalizeAnthropicRequest(model: string, request: AnthropicRequest): AnthropicRequest {
  const normalizedModel = model.toLowerCase();
  const adaptiveOnlyModel = matchesModelPattern(normalizedModel, ADAPTIVE_ONLY_MODEL_PATTERNS);
  const sonnetWithAdaptiveThinking = matchesModelPattern(normalizedModel, SONNET_WITH_ADAPTIVE_THINKING_PATTERNS);
  let normalized = stripNonCoreThinkingForCompatModel(normalizedModel.includes('claude'), request);

  if (!adaptiveOnlyModel && !sonnetWithAdaptiveThinking) return normalized;

  if (matchesModelPattern(normalizedModel, THINKING_UNSET_ONLY_MODEL_PATTERNS) && normalized.thinking !== undefined) {
    const { thinking: _thinking, ...rest } = normalized;
    normalized = rest;
  }

  if (normalized.thinking?.type === 'enabled') {
    normalized = { ...normalized, thinking: { type: 'adaptive' } };
  }

  if (adaptiveOnlyModel && (normalized.temperature !== undefined || normalized.top_p !== undefined || normalized.top_k !== undefined)) {
    const { temperature: _temperature, top_p: _topP, top_k: _topK, ...rest } = normalized;
    normalized = rest;
  }

  if (sonnetWithAdaptiveThinking && normalized.thinking?.type === 'adaptive' && normalized.thinking.display === undefined) {
    normalized = {
      ...normalized,
      thinking: { ...normalized.thinking, display: 'summarized' }
    };
  }

  return normalized;
}
