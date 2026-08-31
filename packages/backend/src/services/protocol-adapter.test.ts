import { describe, expect, test } from 'vitest';

import { applyReasoningEffortNoneTranslation } from './protocol-adapter.js';

describe('applyReasoningEffortNoneTranslation', () => {
  test("reasoning_effort='none' is replaced by thinking disabled", () => {
    const params: any = { reasoning_effort: 'none' };

    applyReasoningEffortNoneTranslation(params, { reasoning_effort: 'none' });

    expect(params).toEqual({ thinking: { type: 'disabled' } });
  });

  test('effort levels other than none are forwarded verbatim', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'max']) {
      const params: any = { reasoning_effort: effort };

      applyReasoningEffortNoneTranslation(params, { reasoning_effort: effort });

      expect(params).toEqual({ reasoning_effort: effort });
    }
  });

  test('explicit thinking param wins and is not overridden', () => {
    const explicit = { type: 'enabled' };
    const params: any = { thinking: explicit, reasoning_effort: 'none' };

    applyReasoningEffortNoneTranslation(params, { reasoning_effort: 'none', thinking: explicit });

    expect(params.thinking).toBe(explicit);
    expect(params.reasoning_effort).toBe('none');
  });

  test('request without reasoning_effort is untouched', () => {
    const params: any = { temperature: 1 };

    applyReasoningEffortNoneTranslation(params, {});

    expect(params).toEqual({ temperature: 1 });
  });
});
