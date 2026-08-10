import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('../resolve.js', () => ({
  resolveClassifierModel: vi.fn(async () => ({
    provider: { name: 'judge', base_url: 'https://judge.test', api_key: 'key' },
    model: 'judge-model',
  })),
}));
vi.mock('../../../utils/crypto.js', () => ({ decryptApiKey: (value: string) => value }));
vi.mock('../../../utils/api-endpoint-builder.js', () => ({ buildChatCompletionsEndpoint: () => 'https://judge.test/v1/chat/completions' }));
vi.mock('../../../utils/upstream-fetch.js', () => ({ upstreamFetch: mocks.fetch }));

import { LLMJudge } from './llm-judge.js';

const signal = {
  intentText: 'Review this pull request for concurrency bugs.',
  toolSignals: [],
  hardHints: [],
  originalRequest: {},
};
const config = {
  type: 'real' as const,
  provider_id: 'judge-provider',
  model: 'judge-model',
};

describe('LLMJudge', () => {
  test('accepts only a stable intent_label and sends the built-in taxonomy prompt', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"intent_label":"code_review","confidence":0.9,"reason":"The user requests a review."}' } }] }),
    });

    const result = await LLMJudge.decide(signal, config);

    expect(result.category).toBe('code_review');
    expect(result.confidence).toBe(0.9);
    expect(result.metadata?.promptVersion).toBe('intent-router-v1');
    const request = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(request.messages[0].content).toContain('code_review');
    expect(request.messages[0].content).toContain('intent_label');
  });

  test('rejects an LLM category outside the stable taxonomy', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"intent_label":"debug"}' } }] }),
    });

    await expect(LLMJudge.decide(signal, config)).rejects.toThrow('Unsupported intent label: debug');
  });
});
