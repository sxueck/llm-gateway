import { describe, expect, it } from 'vitest';
import { normalizeAnthropicRequest } from './anthropic-request-normalizer.js';

const baseRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  messages: [{ role: 'user' as const, content: 'Review this change.' }],
};

describe('normalizeAnthropicRequest', () => {
  describe('adaptive thinking handling (Sonnet 5)', () => {
    it('does not inject thinking when the client omits it', () => {
      expect(normalizeAnthropicRequest('claude-sonnet-5', baseRequest).thinking).toBeUndefined();
    });

    it('adds summarized display to an explicit adaptive configuration', () => {
      expect(normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        thinking: { type: 'adaptive' },
      }).thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    });

    it('preserves an explicit disabled thinking configuration', () => {
      expect(normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        thinking: { type: 'disabled' },
      }).thinking).toEqual({ type: 'disabled' });
    });
  });

  describe('sampling parameter stripping', () => {
    it('strips temperature, top_p and top_k for Sonnet 5', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      });
      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.top_k).toBeUndefined();
    });

    it('strips a single sampling parameter', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        temperature: 0,
      });
      expect(result.temperature).toBeUndefined();
    });

    it('strips sampling parameters for Opus 4.7 and 4.8', () => {
      for (const model of ['claude-opus-4-7', 'claude-opus-4-8']) {
        const result = normalizeAnthropicRequest(model, {
          ...baseRequest,
          model,
          temperature: 0.5,
          top_p: 0.95,
        });
        expect(result.temperature).toBeUndefined();
        expect(result.top_p).toBeUndefined();
      }
    });

    it('preserves sampling parameters for legacy models', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-4-6', {
        ...baseRequest,
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
      });
      expect(result.temperature).toBe(0.7);
      expect(result.top_p).toBe(0.9);
      expect(result.top_k).toBe(40);
    });
  });

  describe('manual extended thinking conversion', () => {
    it('converts enabled thinking to adaptive for Sonnet 5', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        thinking: { type: 'enabled', budget_tokens: 32000 },
      });
      expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });

    it('converts enabled thinking to adaptive for Opus 4.8 without forcing display', () => {
      const result = normalizeAnthropicRequest('claude-opus-4-8', {
        ...baseRequest,
        model: 'claude-opus-4-8',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });
      expect(result.thinking).toEqual({ type: 'adaptive' });
    });

    it('does not touch manual extended thinking on older models', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-4-5', {
        ...baseRequest,
        model: 'claude-sonnet-4-5',
        thinking: { type: 'enabled', budget_tokens: 10000 },
      });
      expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    });
  });

  describe('combined normalization', () => {
    it('strips sampling params and converts thinking together', () => {
      const result = normalizeAnthropicRequest('claude-sonnet-5', {
        ...baseRequest,
        temperature: 0.5,
        top_p: 0.8,
        thinking: { type: 'enabled', budget_tokens: 20000 },
      });
      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    });
  });

  describe('Sonnet 4.6 adaptive compatibility', () => {
    it('converts manual thinking to summarized adaptive without stripping sampling parameters', () => {
      const request = {
        ...baseRequest,
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        top_p: 0.9,
        thinking: { type: 'enabled', budget_tokens: 8000 } as const,
      };
      expect(normalizeAnthropicRequest('claude-sonnet-4-6', request)).toEqual({
        ...request,
        thinking: { type: 'adaptive', display: 'summarized' },
      });
    });

    it('preserves omitted thinking so the model default remains disabled', () => {
      const request = { ...baseRequest, model: 'claude-sonnet-4-6' };
      expect(normalizeAnthropicRequest('claude-sonnet-4-6', request)).toEqual(request);
    });
  });

  describe('Fable 5 / Mythos 5 thinking-unset-only models', () => {
    it('strips an adaptive thinking object (sending type causes HTTP 400 upstream)', () => {
      const result = normalizeAnthropicRequest('claude-fable-5', {
        ...baseRequest,
        model: 'claude-fable-5',
        thinking: { type: 'adaptive', display: 'summarized' },
      });
      expect(result.thinking).toBeUndefined();
    });

    it('strips an enabled thinking object instead of converting it to adaptive', () => {
      const result = normalizeAnthropicRequest('claude-fable-5', {
        ...baseRequest,
        model: 'claude-fable-5',
        thinking: { type: 'enabled', budget_tokens: 32000 },
      });
      expect(result.thinking).toBeUndefined();
    });

    it('strips a disabled thinking object (disabled is unsupported on these models)', () => {
      const result = normalizeAnthropicRequest('claude-mythos-5', {
        ...baseRequest,
        model: 'claude-mythos-5',
        thinking: { type: 'disabled' },
      });
      expect(result.thinking).toBeUndefined();
    });

    it('leaves thinking unset when the client omits it', () => {
      const result = normalizeAnthropicRequest('claude-fable-5', {
        ...baseRequest,
        model: 'claude-fable-5',
      });
      expect(result.thinking).toBeUndefined();
    });

    it('strips thinking and sampling parameters together', () => {
      const result = normalizeAnthropicRequest('claude-fable-5', {
        ...baseRequest,
        model: 'claude-fable-5',
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        thinking: { type: 'adaptive', display: 'summarized' },
      });
      expect(result.thinking).toBeUndefined();
      expect(result.temperature).toBeUndefined();
      expect(result.top_p).toBeUndefined();
      expect(result.top_k).toBeUndefined();
    });

    it('preserves output_config so effort-based depth control still reaches the upstream', () => {
      const result = normalizeAnthropicRequest('claude-fable-5', {
        ...baseRequest,
        model: 'claude-fable-5',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
      });
      expect(result.thinking).toBeUndefined();
      expect(result.output_config).toEqual({ effort: 'medium' });
    });
  });
});
