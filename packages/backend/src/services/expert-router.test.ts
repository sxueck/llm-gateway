import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn() },
  expertRoutingLogDb: { create: vi.fn() },
  expertRoutingTrainingRecordDb: { createOrIncrement: vi.fn() },
  expertRoutingSessionBindingDb: {
    getActiveBinding: vi.fn(),
    createOrSelectBinding: vi.fn(),
    deleteBinding: vi.fn(),
    cleanupExpired: vi.fn(),
  },
  providerDb: { getById: vi.fn() },
  modelDb: { getById: vi.fn() },
  routingConfigDb: { getById: vi.fn() },
  decide: vi.fn(),
  classifyIntent: vi.fn(),
}));
vi.mock("../db/index.js", () => ({
  ...(mocks.expertRoutingConfigDb && {
    expertRoutingConfigDb: mocks.expertRoutingConfigDb,
    expertRoutingLogDb: mocks.expertRoutingLogDb,
    expertRoutingTrainingRecordDb: mocks.expertRoutingTrainingRecordDb,
    expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
    providerDb: mocks.providerDb,
    modelDb: mocks.modelDb,
    routingConfigDb: mocks.routingConfigDb,
  }),
}));
vi.mock("./expert-router/intent-router-client.js", () => ({
  classifyIntent: mocks.classifyIntent,
}));
vi.mock("./expert-router/decision/llm-judge.js", () => ({
  LLMJudge: { decide: mocks.decide },
}));
vi.mock("./expert-router/preprocess/index.js", () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(async (request: any) => ({
      intentText: request.body?.messages?.[0]?.content ?? "route me",
      toolSignals: [],
      hardHints: [],
      originalRequest: request,
      stats: { promptTokens: 1, cleanedLength: 8 },
    })),
  },
}));

import { ExpertRouter } from "./expert-router.js";
const remoteResult = (overrides: Record<string, unknown> = {}) => ({
  object: "intent.classification",
  model: "intent-router-v2",
  revision: "rev",
  latency_ms: 10,
  stats: { batch_size: 1, cache_hits: 0, inference_ms: 8 },
  data: [
    {
      index: 0,
      truncated: false,
      token_count: 5,
      labels: [{ label: "code_review", domain: "coding", score: 0.82 }],
      route: {
        intent: "code_review",
        domain: "coding",
        rejected: false,
        reason: "argmax",
        top1_score: 0.82,
      },
    },
  ],
  ...overrides,
});
const config = () => ({
  llm_second_pass: {
    type: "real",
    provider_id: "classifier",
    model: "classifier",
  },
  experts: [
    {
      id: "expert-review",
      category: "code_review",
      type: "real",
      provider_id: "review",
      model: "review",
    },
  ],
  fallback: { type: "real", provider_id: "fallback", model: "fallback" },
  session_binding_policy: { idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
});

describe("ExpertRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing",
      enabled: 1,
      config: JSON.stringify(config()),
    });
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(
      null,
    );
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue(
      { winner: true, row: {} },
    );
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({
      id,
      name: id,
      base_url: "https://example.test",
      api_key: "key",
    }));
    mocks.classifyIntent.mockResolvedValue(remoteResult());
  });
  test("uses an accepted remote intent to select an expert without LLM fallback", async () => {
    const result = await new ExpertRouter().route(
      { body: { messages: [{ role: "user", content: "review" }] } },
      "routing",
      {},
    );
    expect(result.expert.id).toBe("expert-review");
    expect(mocks.decide).not.toHaveBeenCalled();
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.route_source).toBe("intent_api");
    expect(JSON.parse(log.classifier_request).model).toBe("intent-router-v2");
  });
  test("uses LLM fallback when the remote policy rejects an intent", async () => {
    mocks.classifyIntent.mockResolvedValue(
      remoteResult({
        data: [
          {
            index: 0,
            truncated: false,
            token_count: 2,
            labels: [],
            route: {
              intent: "out_of_scope",
              domain: "out_of_scope",
              rejected: true,
              reason: "short_text",
              top1_score: 0.4,
            },
          },
        ],
      }),
    );
    mocks.decide.mockResolvedValue({
      category: "code_review",
      confidence: 1,
      source: "llm",
      metadata: {},
    });
    const result = await new ExpertRouter().route(
      { body: { messages: [{ role: "user", content: "hi" }] } },
      "routing",
      {},
    );
    expect(result.expert.id).toBe("expert-review");
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  test("uses LLM fallback when the remote service fails", async () => {
    mocks.classifyIntent.mockRejectedValue(new Error("unavailable"));
    mocks.decide.mockResolvedValue({
      category: "code_review",
      confidence: 1,
      source: "llm",
      metadata: {},
    });
    const result = await new ExpertRouter().route(
      { body: { messages: [{ role: "user", content: "review" }] } },
      "routing",
      {},
    );
    expect(result.expert.id).toBe("expert-review");
    expect(mocks.decide).toHaveBeenCalledOnce();
  });
  test("reuses a session binding without calling either classifier", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "expert-review",
      route_source: "intent_api",
    });
    const result = await new ExpertRouter().route(
      {
        headers: { "x-session-id": "s" },
        body: { messages: [{ role: "user", content: "review" }] },
      },
      "routing",
      { virtualKeyId: "key" },
    );
    expect(result.expert.id).toBe("expert-review");
    expect(mocks.classifyIntent).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
