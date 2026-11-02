import { describe, expect, test } from 'vitest';

import { ProtocolAdapter, applyReasoningEffortNoneTranslation } from './protocol-adapter.js';

describe('chatCompletion request param forwarding', () => {
  function captureAdapter() {
    let captured: any;
    const adapter = new ProtocolAdapter();
    (adapter as any).getOpenAIClient = () => ({
      chat: {
        completions: {
          create: async (params: any) => {
            captured = params;
            return {
              id: 'resp_1',
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      },
    });
    return { adapter, getCaptured: () => captured };
  }

  const config = {
    provider: 'p',
    apiKey: 'k',
    model: 'test-model',
    baseUrl: 'http://upstream.test',
  } as any;
  const messages = [{ role: 'user', content: 'hello' }];

  test('max_completion_tokens is forwarded verbatim, not renamed to max_tokens', async () => {
    const { adapter, getCaptured } = captureAdapter();

    await adapter.chatCompletion(config, messages, { max_completion_tokens: 123 });

    expect(getCaptured().max_completion_tokens).toBe(123);
    expect(getCaptured().max_tokens).toBeUndefined();
  });

  test('max_tokens is still forwarded when it is what the client sent', async () => {
    const { adapter, getCaptured } = captureAdapter();

    await adapter.chatCompletion(config, messages, { max_tokens: 456 });

    expect(getCaptured().max_tokens).toBe(456);
    expect(getCaptured().max_completion_tokens).toBeUndefined();
  });

  test('sampling extras are forwarded: n, seed, logit_bias, logprobs, top_logprobs, metadata, user', async () => {
    const { adapter, getCaptured } = captureAdapter();

    await adapter.chatCompletion(config, messages, {
      n: 3,
      seed: 7,
      logit_bias: { '50256': -100 },
      logprobs: true,
      top_logprobs: 5,
      metadata: { trace: 'x' },
      user: 'user-1',
    });

    const captured = getCaptured();
    expect(captured.n).toBe(3);
    expect(captured.seed).toBe(7);
    expect(captured.logit_bias).toEqual({ '50256': -100 });
    expect(captured.logprobs).toBe(true);
    expect(captured.top_logprobs).toBe(5);
    expect(captured.metadata).toEqual({ trace: 'x' });
    expect(captured.user).toBe('user-1');
  });

  test('invalid messages fail as a 400 client error, not a 500', async () => {
    const { adapter } = captureAdapter();

    await expect(adapter.chatCompletion(config, [], {})).rejects.toMatchObject({
      status: 400,
    });
  });
});

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
