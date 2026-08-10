import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn() },
  expertRoutingLogDb: { create: vi.fn() },
  expertRoutingTrainingRecordDb: { createOrIncrement: vi.fn() },
  expertRoutingSessionBindingDb: {
    getActiveBinding: vi.fn(),
    createOrSelectBinding: vi.fn(),
    deleteBinding: vi.fn(),
    deleteByExpert: vi.fn(),
    deleteByConfig: vi.fn(),
    cleanupExpired: vi.fn(),
  },
  providerDb: { getById: vi.fn() },
  modelDb: { getById: vi.fn() },
  routingConfigDb: { getById: vi.fn() },
  decide: vi.fn(),
  classify: vi.fn(),
  isReady: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  expertRoutingTrainingRecordDb: mocks.expertRoutingTrainingRecordDb,
  expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
  providerDb: mocks.providerDb,
  modelDb: mocks.modelDb,
  routingConfigDb: mocks.routingConfigDb,
}));

vi.mock('./expert-router/local/model-assets.js', () => ({
  isLocalClassifierReady: mocks.isReady,
  loadLocalClassifierAssets: vi.fn(),
}));

vi.mock('./expert-router/local/classifier.js', () => ({
  classifyWithLocalOnnx: mocks.classify,
}));

vi.mock('./expert-router/decision/llm-judge.js', () => ({
  LLMJudge: { decide: mocks.decide },
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

function baseConfig(overrides: Record<string, any> = {}) {
  return {
    local_classifier: { model_repo: 'r', revision: 'rev', onnx_file: 'e.onnx', max_tokens: 1024 },
    llm_second_pass: {
      type: 'real',
      provider_id: 'classifier-provider',
      model: 'classifier-model',
    },
    experts: [
      {
        id: 'expert-review',
        category: 'code_review',
        type: 'real',
        provider_id: 'review-provider',
        model: 'review-model',
      },
    ],
    fallback: {
      type: 'real',
      provider_id: 'fallback-provider',
      model: 'fallback-model',
    },
    session_binding_policy: { idle_ttl_seconds: 86400, absolute_ttl_seconds: 2592000 },
    ...overrides,
  };
}

describe('ExpertRouter route flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isReady.mockReturnValue(false);
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingTrainingRecordDb.createOrIncrement.mockResolvedValue(undefined);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({
      row: { expert_id: 'expert-review', route_source: 'llm_second_pass' },
      winner: true,
    });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({
      id,
      name: id,
      base_url: 'https://example.test',
      api_key: 'key',
    }));
  });

  test('LLM second pass resolving an eligible expert persists a binding (FR-8)', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.decide.mockResolvedValue({ category: 'code_review', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      {
        headers: { 'x-session-id': 'session-1' },
        body: { messages: [{ role: 'user', content: 'review this code' }] },
      },
      'routing-a',
      { virtualKeyId: 'vk-a' }
    );

    expect(result.expert.id).toBe('expert-review');
    expect(result.providerId).toBe('review-provider');
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).toHaveBeenCalledOnce();
    expect(mocks.expertRoutingLogDb.create).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    expect(log.route_source).toBe('llm_second_pass');
    expect(mocks.expertRoutingTrainingRecordDb.createOrIncrement).toHaveBeenCalledWith(
      expect.objectContaining({
        expert_routing_id: 'routing-a',
        judge_intent_label: 'code_review',
        final_intent_label: 'code_review',
        status: 'pending_review',
      })
    );
  });

  test('fallback path does NOT persist a session binding (FR-8)', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    // LLM returns a category with no mapped expert.
    mocks.decide.mockResolvedValue({ category: 'deployment', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      {
        headers: { 'x-session-id': 'session-1' },
        body: { messages: [{ role: 'user', content: 'deploy it' }] },
      },
      'routing-a',
      { virtualKeyId: 'vk-a' }
    );

    expect(result.expert.id).toBe('fallback');
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).not.toHaveBeenCalled();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls.at(-1)![0];
    expect(log.route_source).toBe('fallback');
  });

  test('LLM second pass does not route an ineligible label to an expert', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig({
        experts: [{
          id: 'expert-deployment',
          category: 'deployment',
          type: 'real',
          provider_id: 'deployment-provider',
          model: 'deployment-model',
        }],
      })),
    });
    mocks.decide.mockResolvedValue({ category: 'deployment', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      { body: { messages: [{ role: 'user', content: 'deploy it' }] } },
      'routing-a',
      {}
    );

    expect(result.expert.id).toBe('fallback');
  });

  test('local ONNX eligible label selects expert without LLM second pass (FR-4)', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.classify.mockResolvedValue({
      policy: {
        chosenLabel: 'code_review',
        rejected: false,
        top1: { label: 'code_review', score: 0.82 },
        top2: { label: 'architecture_consultation', score: 0.05 },
      },
      ranked: [],
      revision: 'rev',
      latencyMs: 10,
      seqLen: 5,
      truncated: false,
    });

    const router = new ExpertRouter();
    const result = await router.route(
      { body: { messages: [{ role: 'user', content: 'review my PR' }] } },
      'routing-a',
      {}
    );

    expect(result.expert.id).toBe('expert-review');
    expect(mocks.decide).not.toHaveBeenCalled();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    expect(log.route_source).toBe('local_onnx');
    const classifierRequest = JSON.parse(log.classifier_request);
    expect(classifierRequest.model).toContain('onnx/');
    expect(classifierRequest.input).toBe('review my PR');
  });

  test('eligible local label that is rejected routes to LLM second pass (FR-5)', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.classify.mockResolvedValue({
      policy: {
        chosenLabel: 'out_of_scope',
        rejected: true,
        rejectionReason: 'low_confidence',
        top1: { label: 'out_of_scope', score: 0.1 },
        top2: { label: 'code_review', score: 0.09 },
      },
      ranked: [],
      revision: 'rev',
      latencyMs: 10,
      seqLen: 5,
      truncated: false,
    });
    mocks.decide.mockResolvedValue({ category: 'code_review', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      { body: { messages: [{ role: 'user', content: 'hi' }] } },
      'routing-a',
      {}
    );

    expect(result.expert.id).toBe('expert-review');
    expect(mocks.decide).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    expect(log.route_source).toBe('llm_second_pass');
  });

  test('session binding hit routes directly without inference and persists no new binding (FR-6)', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: 'expert-review',
      route_source: 'local_onnx',
    });

    const router = new ExpertRouter();
    const result = await router.route(
      {
        headers: { 'x-session-id': 'session-1' },
        body: { messages: [{ role: 'user', content: 'anything' }] },
      },
      'routing-a',
      { virtualKeyId: 'vk-a' }
    );

    expect(result.expert.id).toBe('expert-review');
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    // Session reuse must not create a competing binding.
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).not.toHaveBeenCalled();
    expect(mocks.expertRoutingLogDb.create).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    expect(log.route_source).toBe('session');
  });

  test('a divergent race loser returns its own candidate and writes exactly one log row', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.decide.mockResolvedValue({ category: 'code_review', confidence: 1, source: 'llm', metadata: {} });
    // Lost the race; the persisted winner is a different expert.
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({
      row: { expert_id: 'expert-other', route_source: 'local_onnx' },
      winner: false,
    });

    const router = new ExpertRouter();
    const result = await router.route(
      {
        headers: { 'x-session-id': 'session-1' },
        body: { messages: [{ role: 'user', content: 'review this code' }] },
      },
      'routing-a',
      { virtualKeyId: 'vk-a' }
    );

    // The loser's own candidate is returned; the race is observability-only.
    expect(result.expert.id).toBe('expert-review');
    // Exactly one analytics row — no second "session race" row.
    expect(mocks.expertRoutingLogDb.create).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    expect(log.route_source).toBe('llm_second_pass');
  });

  test('local classifier unavailable falls through to LLM second pass (FR-5)', async () => {
    mocks.isReady.mockReturnValue(false);
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.decide.mockResolvedValue({ category: 'code_review', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      { body: { messages: [{ role: 'user', content: 'review' }] } },
      'routing-a',
      {}
    );

    expect(result.expert.id).toBe('expert-review');
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.decide).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    const meta = JSON.parse(log.classifier_response);
    expect(meta.localUnavailable).toBe(true);
  });

  test('local classifier error falls through to LLM second pass (FR-5)', async () => {
    mocks.isReady.mockReturnValue(true);
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-a',
      enabled: 1,
      config: JSON.stringify(baseConfig()),
    });
    mocks.classify.mockRejectedValue(new Error('onnx blew up'));
    mocks.decide.mockResolvedValue({ category: 'code_review', confidence: 1, source: 'llm', metadata: {} });

    const router = new ExpertRouter();
    const result = await router.route(
      { body: { messages: [{ role: 'user', content: 'review' }] } },
      'routing-a',
      {}
    );

    expect(result.expert.id).toBe('expert-review');
    expect(mocks.decide).toHaveBeenCalledOnce();
    const log = (mocks.expertRoutingLogDb.create as any).mock.calls[0][0];
    const meta = JSON.parse(log.classifier_response);
    expect(meta.localError).toBe('onnx blew up');
  });
});
