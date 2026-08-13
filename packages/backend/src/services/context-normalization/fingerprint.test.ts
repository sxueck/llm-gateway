import { describe, expect, test } from 'vitest';

import {
  computeContextFingerprint,
  extractReasoningConfigByProtocol,
  extractToolsFlag,
  type ContextFingerprintInput,
} from './fingerprint.js';

const baseInput: ContextFingerprintInput = {
  protocol: 'openai',
  providerId: 'provider-a',
  model: 'gpt-4o',
  body: {},
};

describe('extractReasoningConfigByProtocol', () => {
  test('openai: uses body.reasoning_effort when present', () => {
    expect(
      extractReasoningConfigByProtocol('openai', { reasoning_effort: 'high' }, undefined)
    ).toEqual({ effort: 'high' });
  });

  test('openai: falls back to body.reasoning.effort (Responses API)', () => {
    expect(
      extractReasoningConfigByProtocol('openai', { reasoning: { effort: 'low' } }, undefined)
    ).toEqual({ effort: 'low' });
  });

  test('openai: falls back to forcedReasoningEffort', () => {
    expect(
      extractReasoningConfigByProtocol('openai', {}, 'medium')
    ).toEqual({ effort: 'medium' });
  });

  test('openai: normalizes absence to the none sentinel', () => {
    expect(extractReasoningConfigByProtocol('openai', {}, undefined)).toEqual({ effort: 'none' });
  });

  test('anthropic: returns the thinking config object when present', () => {
    const thinking = { type: 'enabled', budget_tokens: 8000 };
    expect(extractReasoningConfigByProtocol('anthropic', { thinking }, undefined)).toBe(thinking);
  });

  test('anthropic: normalizes absence to the none sentinel', () => {
    expect(extractReasoningConfigByProtocol('anthropic', {}, undefined)).toBe('none');
  });

  test('gemini: returns generationConfig.thinkingConfig when present', () => {
    const thinkingConfig = { thinkingLevel: 'low' };
    expect(
      extractReasoningConfigByProtocol('gemini', { generationConfig: { thinkingConfig } }, undefined)
    ).toBe(thinkingConfig);
  });

  test('gemini: normalizes absence to the none sentinel', () => {
    expect(extractReasoningConfigByProtocol('gemini', {}, undefined)).toBe('none');
  });
});

describe('extractToolsFlag', () => {
  test('openai: true when body.tools is a non-empty array', () => {
    expect(extractToolsFlag('openai', { tools: [{ type: 'function' }] })).toBe(true);
  });

  test('openai: false when body.tools is empty or absent', () => {
    expect(extractToolsFlag('openai', { tools: [] })).toBe(false);
    expect(extractToolsFlag('openai', {})).toBe(false);
  });

  test('anthropic: true when body.tools is a non-empty array', () => {
    expect(extractToolsFlag('anthropic', { tools: [{ name: 'x' }] })).toBe(true);
  });

  test('gemini: true when functionDeclarations is a non-empty array', () => {
    expect(
      extractToolsFlag('gemini', { tools: [{ functionDeclarations: [{ name: 'x' }] }] })
    ).toBe(true);
  });

  test('gemini: false when functionDeclarations is absent', () => {
    expect(extractToolsFlag('gemini', { tools: [] })).toBe(false);
    expect(extractToolsFlag('gemini', {})).toBe(false);
  });
});

describe('computeContextFingerprint', () => {
  test('is a 64-char hex sha256', () => {
    const fp = computeContextFingerprint(baseInput);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deterministic for identical inputs', () => {
    expect(computeContextFingerprint(baseInput)).toBe(computeContextFingerprint(baseInput));
  });

  test('changes when model differs', () => {
    expect(computeContextFingerprint(baseInput)).not.toBe(
      computeContextFingerprint({ ...baseInput, model: 'claude-3' })
    );
  });

  test('changes when protocol differs (even with same model/provider)', () => {
    const anthropic = computeContextFingerprint({ ...baseInput, protocol: 'anthropic' });
    expect(computeContextFingerprint(baseInput)).not.toBe(anthropic);
  });

  test('changes when reasoning effort differs (same model)', () => {
    const low = computeContextFingerprint({
      ...baseInput,
      body: { reasoning_effort: 'low' },
    });
    const high = computeContextFingerprint({
      ...baseInput,
      body: { reasoning_effort: 'high' },
    });
    expect(low).not.toBe(high);
  });

  test('changes when Responses body.reasoning.effort differs', () => {
    const low = computeContextFingerprint({
      ...baseInput,
      body: { reasoning: { effort: 'low' } },
    });
    const high = computeContextFingerprint({
      ...baseInput,
      body: { reasoning: { effort: 'high' } },
    });
    expect(low).not.toBe(high);
  });

  test('changes when tools flag differs', () => {
    const withTools = computeContextFingerprint({
      ...baseInput,
      body: { tools: [{ type: 'function' }] },
    });
    expect(computeContextFingerprint(baseInput)).not.toBe(withTools);
  });

  test('insensitive to reasoningConfig internal key order (canonical)', () => {
    const a = computeContextFingerprint({
      protocol: 'anthropic',
      providerId: 'p',
      model: 'm',
      body: { thinking: { budget_tokens: 8000, type: 'enabled' } },
    });
    const b = computeContextFingerprint({
      protocol: 'anthropic',
      providerId: 'p',
      model: 'm',
      body: { thinking: { type: 'enabled', budget_tokens: 8000 } },
    });
    expect(a).toBe(b);
  });
});
