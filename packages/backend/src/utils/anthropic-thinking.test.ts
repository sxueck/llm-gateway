import { describe, expect, it } from 'vitest';
import { applyAnthropicThinkingDefaults } from './anthropic-thinking.js';

const request = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  messages: [{ role: 'user' as const, content: 'Review this change.' }],
};

describe('applyAnthropicThinkingDefaults', () => {
  it('enables summarized adaptive thinking for Sonnet 5 when omitted', () => {
    expect(applyAnthropicThinkingDefaults('claude-sonnet-5', request).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
  });

  it('adds summarized display to an explicit adaptive configuration', () => {
    expect(applyAnthropicThinkingDefaults('claude-sonnet-5', {
      ...request,
      thinking: { type: 'adaptive' },
    }).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
  });

  it('preserves explicit thinking settings and other models', () => {
    expect(applyAnthropicThinkingDefaults('claude-sonnet-5', {
      ...request,
      thinking: { type: 'disabled' },
    }).thinking).toEqual({ type: 'disabled' });

    expect(applyAnthropicThinkingDefaults('claude-sonnet-4-6', request).thinking).toBeUndefined();
  });
});
