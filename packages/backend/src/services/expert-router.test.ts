import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn() },
  expertRoutingLogDb: { create: vi.fn() },
  providerDb: { getById: vi.fn() },
  modelDb: { getById: vi.fn() },
  routingConfigDb: { getById: vi.fn() },
  decide: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  providerDb: mocks.providerDb,
  modelDb: mocks.modelDb,
  routingConfigDb: mocks.routingConfigDb,
}));

vi.mock('./expert-router/decision/llm-judge.js', () => ({
  LLMJudge: {
    decide: mocks.decide,
  },
}));

vi.mock('./expert-router/preprocess/index.js', () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(async (request: any) => ({
      intentText: request.body?.messages?.[0]?.content ?? 'route me',
      toolSignals: [],
      hardHints: [],
      originalRequest: request,
      stats: { promptTokens: 1, cleanedLength: 8 },
    })),
  },
}));

import { ExpertRouter } from './expert-router.js';
import { expertRoutingSessionBindings } from './expert-router/session-binding.js';

describe('ExpertRouter session bindings', () => {
  beforeEach(() => {
    expertRoutingSessionBindings.clear();
    mocks.expertRoutingConfigDb.getById.mockReset();
    mocks.expertRoutingLogDb.create.mockReset();
    mocks.providerDb.getById.mockReset();
    mocks.modelDb.getById.mockReset();
    mocks.routingConfigDb.getById.mockReset();
    mocks.decide.mockReset();
  });

  test('does not store a session binding when expert resolution fails', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify({
        classifier: {
          type: 'real',
          provider_id: 'classifier-provider',
          model: 'classifier-model',
          prompt_template: '{{USER_PROMPT}}',
        },
        experts: [
          {
            id: 'expert-coding',
            category: 'coding',
            type: 'real',
            provider_id: 'missing-provider',
            model: 'missing-model',
          },
        ],
      }),
    });
    mocks.decide.mockResolvedValue({
      category: 'coding',
      confidence: 1,
      source: 'llm',
      metadata: {},
    });
    mocks.providerDb.getById.mockResolvedValue(null);

    const router = new ExpertRouter();

    await expect(
      router.route(
        {
          headers: { 'x-session-id': 'session-1' },
          body: { messages: [{ role: 'user', content: 'write code' }] },
        },
        'routing-a',
        { virtualKeyId: 'vk-a' }
      )
    ).rejects.toThrow('Expert provider not found: missing-provider');

    expect(expertRoutingSessionBindings.get('routing-a', 'vk-a', 'session-1')).toBeUndefined();
  });
});
