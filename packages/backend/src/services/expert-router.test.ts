import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn() },
  expertRoutingLogDb: { create: vi.fn() },
  expertRoutingSessionBindingDb: {
    getActiveBinding: vi.fn(),
    createOrSelectBinding: vi.fn(),
    deleteBinding: vi.fn(),
    cleanupExpired: vi.fn(),
  },
  providerDb: { getById: vi.fn() },
  modelDb: { getById: vi.fn(), getByProviderId: vi.fn() },
  chooseExpert: vi.fn(),
  chooseDifficulty: vi.fn(),
}));
vi.mock("../db/index.js", () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
  providerDb: mocks.providerDb,
  modelDb: mocks.modelDb,
}));
vi.mock("./expert-router/jev-client.js", () => ({
  chooseExpert: mocks.chooseExpert,
  chooseDifficulty: mocks.chooseDifficulty,
}));
// resolveBindingScope is a pure helper but lives in the repository module,
// which transitively loads db connection + env config; mock it hermetically.
vi.mock("../db/repositories/expert-routing-session-binding.repository.js", () => ({
  resolveBindingScope: (virtualKeyId: string | undefined) =>
    virtualKeyId && virtualKeyId.trim() ? virtualKeyId : "__anonymous__",
}));
vi.mock("./expert-router/preprocess/index.js", () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(async (request: any) => ({
      intentText: request.body?.messages?.[0]?.content ?? "route me",
      stats: { promptTokens: 1, cleanedLength: 8 },
    })),
  },
}));

import { ExpertRouter } from "./expert-router.js";
const config = (overrides: Record<string, unknown> = {}) => ({
  choice_threshold: 0.6,
  experts: [
    { id: "review", category: "review", description: "Review code", type: "real", provider_id: "review", model: "review", band: "low" },
    { id: "fast", category: "simple", description: "Quick answers", type: "real", provider_id: "fast", model: "fast", band: "high" },
  ],
  fallback: { type: "real", provider_id: "fallback", model: "fallback" },
  session_binding_policy: { idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
  ...overrides,
});
const request = (session?: string) => ({
  body: { messages: [{ role: "user", content: "review this" }] },
  headers: session ? { "x-session-id": session } : {},
});

describe("ExpertRouter Jev decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config()),
    });
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({ id, name: id }));
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
    mocks.chooseExpert.mockResolvedValue({
      model: "jev-1.13", confidence: 0.8,
      ranked: [{ expertId: "review", probability: 0.8 }, { expertId: "fast", probability: 0.2 }],
    });
  });

  test("chooses highest probability candidate and records ranked probabilities without the prompt", async () => {
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("review");
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.route_source).toBe("jev");
    expect(log.original_request).toBeUndefined();
    expect(JSON.parse(log.classifier_response).ranked).toEqual([
      { expertId: "review", probability: 0.8 }, { expertId: "fast", probability: 0.2 },
    ]);
  });

  test("low-confidence verdict still resolves inside the verdict band", async () => {
    mocks.chooseExpert.mockResolvedValue({ model: "jev", confidence: 0.5, ranked: [
      { expertId: "review", probability: 0.55 }, { expertId: "fast", probability: 0.45 },
    ] });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(mocks.chooseExpert).toHaveBeenCalledOnce();
  });

  test("falls back to the configured fallback when the whole verdict band is unavailable", async () => {
    mocks.providerDb.getById.mockImplementation(async (id: string) => id === "review" ? null : { id, name: id });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.providerId).toBe("fallback");
  });

  test("follows the persisted expert when a concurrent session binding wins", async () => {
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({
      winner: false, row: { expert_id: "fast" },
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].selected_expert_id).toBe("fast");
  });

  test("routes the cheapest low-band candidate when Jev is unavailable, fallback otherwise", async () => {
    mocks.chooseExpert.mockRejectedValue(new Error("unavailable"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].route_source).toBe("fail_open");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].classifier_model).toBeNull();
    // Verdict band unresolvable → configured fallback takes over.
    mocks.providerDb.getById.mockImplementation(async (id: string) =>
      id === "fallback" ? { id, name: id } : null,
    );
    const fallbackResult = await new ExpertRouter().route(request(), "routing", {});
    expect(fallbackResult?.providerId).toBe("fallback");
  });

  test("reuses a valid session binding without calling Jev", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "review", route_source: "jev",
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(mocks.chooseExpert).not.toHaveBeenCalled();
  });

  test("session reuse logs classifier_model=null, verdict_reused and retains the bound difficulty", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "review", route_source: "jev", difficulty: "medium",
    });
    await new ExpertRouter().route(request("session"), "routing", {});
    expect(mocks.chooseExpert).not.toHaveBeenCalled();
    expect(mocks.chooseDifficulty).not.toHaveBeenCalled();
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.classifier_model).toBeNull();
    expect(log.verdict_reused).toBe(true);
    expect(log.difficulty).toBe("medium");
    expect(log.band).toBe("medium");
    expect(log.classifier_time_ms).toBeNull();
    expect(log.route_source).toBe("session");
    const payload = JSON.parse(log.classifier_response);
    expect(payload.verdictReused).toBe(true);
  });
});

describe("ExpertRouter PR-2 fail_open terminal chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({ id, name: id }));
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
    mocks.chooseExpert.mockRejectedValue(new Error("jev down"));
  });

  test("classifier timeout fails open without retry or latency amplification", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config()),
    });
    mocks.chooseExpert.mockImplementationOnce(() => new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Jev timeout")), 100),
    ));
    const start = performance.now();
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(performance.now() - start).toBeLessThan(500);
    expect(mocks.chooseExpert).toHaveBeenCalledTimes(1);
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].route_source).toBe("fail_open");
  });

  test("fail_open=parent skips the configured fallback and returns null", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config({ fail_open: "parent" })),
    });
    mocks.providerDb.getById.mockResolvedValue(null);
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result).toBeNull();
  });

  test("fail_open=error preserves the legacy throw when no fallback resolves", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({ fail_open: "error", fallback: null })),
    });
    mocks.providerDb.getById.mockResolvedValue(null);
    await expect(new ExpertRouter().route(request(), "routing", {}))
      .rejects.toThrow("Expert routing failed (candidate_unavailable): no fallback configured");
  });

  test("default fail_open=fallback returns null once the chain is exhausted", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config({ fallback: null })),
    });
    mocks.providerDb.getById.mockResolvedValue(null);
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result).toBeNull();
  });

  test("absent verdict resolves cheapest in the low band when escalation is needed", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        fallback: null,
        fail_open: "parent",
        experts: [
          { id: "pricey", category: "deep", type: "real", provider_id: "pricey", model: "p", band: "medium" },
          { id: "premium", category: "deep", type: "real", provider_id: "premium", model: "x", band: "high" },
        ],
      })),
    });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("pricey");
  });
});

describe("ExpertRouter PR-1 difficulty classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        classification_mode: "difficulty",
        experts: [
          { id: "review", category: "review", type: "real", provider_id: "review", model: "review", band: "high" },
          { id: "fast", category: "simple", type: "real", provider_id: "fast", model: "fast", band: "low" },
        ],
      })),
    });
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({ id, name: id }));
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
  });

  test("high difficulty resolves the high band candidate and logs the verdict", async () => {
    mocks.chooseDifficulty.mockResolvedValue({
      model: "jev-difficulty", verdict: "high", confidence: 0.9,
      ranked: [
        { expertId: "high", probability: 0.9 },
        { expertId: "medium", probability: 0.07 },
        { expertId: "low", probability: 0.03 },
      ],
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(mocks.chooseExpert).not.toHaveBeenCalled();
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session" }),
      { expertId: "review", routeSource: "jev", difficulty: "high" },
      60, 3600,
    );
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    const payload = JSON.parse(log.classifier_response);
    expect(payload.mode).toBe("difficulty");
    expect(payload.verdictBand).toBe("high");
    expect(payload.difficulty).toBe("high");
  });

  test("logs Jev-only classifier latency and verdict_reused=0 on a fresh decision", async () => {
    mocks.chooseDifficulty.mockResolvedValue({
      model: "jev-difficulty", verdict: "high", confidence: 0.9,
      ranked: [
        { expertId: "high", probability: 0.9 },
        { expertId: "medium", probability: 0.07 },
        { expertId: "low", probability: 0.03 },
      ],
    });
    await new ExpertRouter().route(request("session"), "routing", {});
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.classifier_model).toBe("jev-difficulty");
    expect(log.verdict_reused).toBe(false);
    expect(typeof log.classifier_time_ms).toBe("number");
    expect(log.classifier_time_ms).toBeGreaterThanOrEqual(0);
    expect(log.difficulty).toBe("high");
    expect(log.band).toBe("high");
  });

  test("real-model cost lookup matches by model name as well as identifier", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        fallback: null,
        fail_open: "parent",
        experts: [
          { id: "cheap", category: "simple", type: "real", provider_id: "p1", model: "cheap-name" },
          { id: "pricey", category: "deep", type: "real", provider_id: "p1", model: "pricey-name" },
        ],
      })),
    });
    mocks.chooseExpert.mockRejectedValue(new Error("jev down"));
    mocks.modelDb.getByProviderId.mockResolvedValue([
      {
        is_virtual: 0,
        model_identifier: "m-cheap",
        name: "cheap-name",
        model_attributes: JSON.stringify({ input_cost_per_token: 0.01, output_cost_per_token: 0.03 }),
      },
      {
        is_virtual: 0,
        model_identifier: "m-pricey",
        name: "pricey-name",
        model_attributes: JSON.stringify({ input_cost_per_token: 0.5, output_cost_per_token: 1.5 }),
      },
    ]);
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("cheap");
  });

  test("low difficulty resolves the cheapest low-band candidate", async () => {
    mocks.chooseDifficulty.mockResolvedValue({
      model: "jev-difficulty", verdict: "low", confidence: 0.85,
      ranked: [{ expertId: "low", probability: 0.85 }, { expertId: "medium", probability: 0.1 }, { expertId: "high", probability: 0.05 }],
    });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("fast");
  });

  test("unknown verdict degrades to the low band", async () => {
    mocks.chooseDifficulty.mockResolvedValue({
      model: "jev-difficulty", verdict: undefined, confidence: 0.4,
      ranked: [],
    });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("fast");
  });

  test("low-confidence but successful classification logs jev, not fail_open", async () => {
    mocks.chooseDifficulty.mockResolvedValue({
      model: "jev-difficulty", verdict: "low", confidence: 0.3,
      ranked: [{ expertId: "low", probability: 0.3 }, { expertId: "medium", probability: 0.1 }, { expertId: "high", probability: 0.05 }],
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].route_source).toBe("jev");
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session" }),
      { expertId: "fast", routeSource: "jev", difficulty: "low" },
      60, 3600,
    );
  });
});

describe("ExpertRouter price banding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
    mocks.chooseExpert.mockRejectedValue(new Error("jev down"));
  });

  test("absent verdict picks the cheapest candidate by blended price", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        fallback: null,
        fail_open: "parent",
        experts: [
          {
            id: "cheap", category: "simple", type: "virtual", model_id: "cheap-model",
          },
          {
            id: "pricey", category: "deep", type: "virtual", model_id: "pricey-model",
          },
        ],
      })),
    });
    mocks.modelDb.getById.mockImplementation(async (id: string) => ({
      id,
      name: id,
      enabled: 1,
      model_attributes: JSON.stringify(
        id === "cheap-model"
          ? { input_cost_per_token: 0.01, output_cost_per_token: 0.03 }
          : { input_cost_per_token: 0.5, output_cost_per_token: 1.5 },
      ),
    }));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("cheap");
  });
});
