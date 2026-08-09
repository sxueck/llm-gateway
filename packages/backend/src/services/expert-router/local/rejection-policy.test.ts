import { describe, expect, test } from 'vitest';
import { applyRejectionPolicy, type RejectionPolicy } from './rejection-policy.js';

function basePolicy(overrides: Partial<RejectionPolicy> = {}): RejectionPolicy {
  return {
    version: 3,
    max_probability: 0.15,
    min_margin: 0.0,
    short_text_max_chars: 3,
    fallback_intent: 'out_of_scope',
    temperature: 1.0,
    enable_flip_rules: true,
    enable_keyword_rules: true,
    flip_rules: [
      { top: 'code_search', second: 'code_explanation', max_margin: 0.2 },
      { top: 'code_modification', second: 'code_repair', max_margin: 0.08 },
    ],
    keyword_rules: [
      { intent: 'code_repair', patterns: ['(traceback|NullPointerException)'] },
      { intent: 'code_review', patterns: ['(code\\s*review|帮我\\s*review)'] },
      { intent: 'workflow_control', patterns: ['^(继续|下一步)[\\s!。?？]*$'] },
      { intent: 'deployment', patterns: ['(kubectl\\s+apply)'] },
    ],
    ...overrides,
  };
}

describe('applyRejectionPolicy — keyword hard-routing', () => {
  test('keyword match overrides model output and bypasses rejection', () => {
    const ranked = [
      { label: 'code_explanation', score: 0.05 }, // below threshold
      { label: 'code_repair', score: 0.04 },
    ];
    const result = applyRejectionPolicy('Traceback (most recent call last)', ranked, basePolicy());
    expect(result.chosenLabel).toBe('code_repair');
    expect(result.rejected).toBe(false);
    expect(result.matchedKeywordIntent).toBe('code_repair');
  });

  test('keyword match still records top1/top2 from the model', () => {
    const ranked = [
      { label: 'code_review', score: 0.9 },
      { label: 'architecture_consultation', score: 0.05 },
    ];
    const result = applyRejectionPolicy('帮我 review 这个 PR', ranked, basePolicy());
    expect(result.chosenLabel).toBe('code_review');
    expect(result.top1.label).toBe('code_review');
  });
});

describe('applyRejectionPolicy — confidence rejection', () => {
  test('top score below max_probability is rejected to fallback_intent', () => {
    const ranked = [
      { label: 'code_review', score: 0.1 },
      { label: 'code_explanation', score: 0.09 },
    ];
    const result = applyRejectionPolicy('a long enough prompt here', ranked, basePolicy());
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('low_confidence');
    expect(result.chosenLabel).toBe('out_of_scope');
  });

  test('short text is rejected even with a high top score', () => {
    const ranked = [{ label: 'code_review', score: 0.95 }, { label: 'x', score: 0.02 }];
    const result = applyRejectionPolicy('hi', ranked, basePolicy());
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('short_text');
  });
});

describe('applyRejectionPolicy — flip rules', () => {
  test('flip fires when top/second match a confused pair within max_margin', () => {
    const ranked = [
      { label: 'code_search', score: 0.5 },
      { label: 'code_explanation', score: 0.45 }, // margin 0.05 <= 0.2
    ];
    const result = applyRejectionPolicy('一段足够长的上下文文本用于路由', ranked, basePolicy());
    expect(result.chosenLabel).toBe('code_explanation');
    expect(result.appliedFlip?.from).toBe('code_search');
    expect(result.appliedFlip?.to).toBe('code_explanation');
    expect(result.appliedFlip?.margin).toBeCloseTo(0.05, 6);
    expect(result.rejected).toBe(false);
  });

  test('flip does NOT fire when margin exceeds max_margin', () => {
    const ranked = [
      { label: 'code_search', score: 0.8 },
      { label: 'code_explanation', score: 0.3 }, // margin 0.5 > 0.2
    ];
    const result = applyRejectionPolicy('一段足够长的上下文文本用于路由', ranked, basePolicy());
    expect(result.chosenLabel).toBe('code_search');
    expect(result.appliedFlip).toBeUndefined();
  });

  test('low confidence still rejects after a would-be flip', () => {
    const ranked = [
      { label: 'code_search', score: 0.1 },
      { label: 'code_explanation', score: 0.09 },
    ];
    const result = applyRejectionPolicy('一段足够长的上下文文本', ranked, basePolicy());
    expect(result.rejected).toBe(true);
    expect(result.chosenLabel).toBe('out_of_scope');
  });
});
