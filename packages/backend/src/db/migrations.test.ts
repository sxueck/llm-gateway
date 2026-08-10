import { describe, expect, test } from 'vitest';
import { normalizeExpertRoutingConfig } from './migrations.js';

describe('normalizeExpertRoutingConfig', () => {
  test('maps legacy expert categories and removes ignored LLM prompt fields', () => {
    const result = normalizeExpertRoutingConfig(JSON.stringify({
      experts: [
        { id: 'repair', category: 'debug', system_prompt: 'legacy criteria' },
        { id: 'general', category: 'other' },
      ],
      llm_second_pass: {
        type: 'real',
        prompt_template: '{{USER_PROMPT}}',
        system_prompt: 'legacy prompt',
        user_prompt_marker: '{{USER_PROMPT}}',
      },
    }));

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.config)).toEqual({
      experts: [
        { id: 'repair', category: 'code_repair' },
        { id: 'general', category: 'general_inquiry' },
      ],
      llm_second_pass: { type: 'real' },
    });
  });
});
