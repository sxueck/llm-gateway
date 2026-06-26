import { describe, expect, test } from 'vitest';

import { matchExpert } from './resolve.js';
import type { ExpertTarget } from '../../types/expert-routing.js';

function expert(id: string, category: string): ExpertTarget {
  return {
    id,
    category,
    type: 'real',
    provider_id: `provider-${id}`,
    model: `model-${id}`,
  };
}

describe('matchExpert', () => {
  test('matches short expert categories when the LLM returns a more specific category', () => {
    const experts = [expert('ai', 'AI'), expert('qa', 'QA')];

    expect(matchExpert('AI assistant', experts)?.id).toBe('ai');
    expect(matchExpert('QA automation', experts)?.id).toBe('qa');
  });

  test('does not partial match one-character classifier output', () => {
    const experts = [expert('qa', 'QA')];

    expect(matchExpert('a', experts)).toBeNull();
  });
});
