import type { AnthropicRequest } from '../types/anthropic.js';

export function applyAnthropicThinkingDefaults(
  model: string,
  request: AnthropicRequest
): AnthropicRequest {
  if (!model.toLowerCase().includes('claude-sonnet-5')) {
    return request;
  }

  if (request.thinking === undefined) {
    return {
      ...request,
      thinking: { type: 'adaptive', display: 'summarized' },
    };
  }

  if (request.thinking.type === 'adaptive' && request.thinking.display === undefined) {
    return {
      ...request,
      thinking: { ...request.thinking, display: 'summarized' },
    };
  }

  return request;
}
