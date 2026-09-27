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
  version: 2,
  experts: [
    { id: "review", type: "real", provider_id: "review", model: "review", band: "high" },
    { id: "fast", type: "real", provider_id: "fast", model: "fast", band: "low" },
  ],
  fallback: { type: "real", provider_id: "fallback", model: "fallback" },
  session_policy: { mode: "sticky", idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
  ...overrides,
});
const request = (session?: string) => ({
  body: { messages: [{ role: "user", content: "review this" }] },
  headers: session ? { "x-session-id": session } : {},
});
const difficulty = (verdict: "low" | "medium" | "high", confidence = 0.9) => ({
  model: "jev-difficulty",
  verdict,
  confidence,
  ranked: [
    { expertId: verdict, probability: confidence },
    { expertId: "medium", probability: 0.07 },
    { expertId: "low", probability: 0.03 },
  ],
});

describe("ExpertRouter difficulty routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config()),
    });
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({ id, name: id }));
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
    mocks.chooseDifficulty.mockResolvedValue(difficulty("high"));
  });

  test("high difficulty resolves the high band candidate and logs the verdict", async () => {
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(result?.tier).toBe("high");
    expect(result?.routeSource).toBe("jev");
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session" }),
      { expertId: "review", routeSource: "jev", difficulty: "high" },
      60, 3600,
    );
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.route_source).toBe("jev");
    expect(log.difficulty).toBe("high");
    expect(log.band).toBe("high");
    expect(log.classification_result).toBe("high");
    expect(log.original_request).toBeUndefined();
    const payload = JSON.parse(log.classifier_response);
    expect(payload.verdictBand).toBe("high");
    expect(payload.difficulty).toBe("high");
    expect(payload.ranked[0]).toEqual({ expertId: "high", probability: 0.9 });
  });

  test("low difficulty resolves the low band candidate", async () => {
    mocks.chooseDifficulty.mockResolvedValue(difficulty("low"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(result?.tier).toBe("low");
  });

  test("low-confidence but successful classification logs jev, not fail_open", async () => {
    mocks.chooseDifficulty.mockResolvedValue(difficulty("low", 0.3));
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].route_source).toBe("jev");
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session" }),
      { expertId: "fast", routeSource: "jev", difficulty: "low" },
      60, 3600,
    );
  });

  test("empty verdict band escalates to the nearest non-empty band", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        fallback: null,
        fail_open: "parent",
        experts: [
          { id: "pricey", type: "real", provider_id: "pricey", model: "p", band: "medium" },
          { id: "premium", type: "real", provider_id: "premium", model: "x", band: "high" },
        ],
      })),
    });
    mocks.chooseDifficulty.mockResolvedValue(difficulty("low"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("pricey");
  });

  test("within a band, config array order decides priority", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        fallback: null,
        fail_open: "parent",
        experts: [
          { id: "first", type: "real", provider_id: "p1", model: "a", band: "low" },
          { id: "second", type: "real", provider_id: "p1", model: "b", band: "low" },
        ],
      })),
    });
    mocks.chooseDifficulty.mockResolvedValue(difficulty("low"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("first");
  });

  test("falls back to the configured fallback when all candidates are unavailable", async () => {
    mocks.providerDb.getById.mockImplementation(async (id: string) => id === "fallback" ? { id, name: id } : null);
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.providerId).toBe("fallback");
    expect(result?.routeSource).toBe("fallback");
  });

  test("follows the persisted expert when a concurrent session binding wins", async () => {
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({
      winner: false, row: { expert_id: "fast" },
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].selected_expert_id).toBe("fast");
  });

  test("Jev failure fails open to the low band candidate without a classifier model", async () => {
    mocks.chooseDifficulty.mockRejectedValue(new Error("unavailable"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(result?.routeSource).toBe("fail_open");
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.route_source).toBe("fail_open");
    expect(log.classifier_model).toBeNull();
    expect(log.classification_result).toBe("low");
  });

  test("reuses a valid session binding without calling Jev", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "review", route_source: "jev",
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(result?.routeSource).toBe("session");
    expect(mocks.chooseDifficulty).not.toHaveBeenCalled();
  });

  test("session reuse logs classifier_model=null, verdict_reused and retains the bound difficulty", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "review", route_source: "jev", difficulty: "medium",
    });
    await new ExpertRouter().route(request("session"), "routing", {});
    expect(mocks.chooseDifficulty).not.toHaveBeenCalled();
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.classifier_model).toBeNull();
    expect(log.verdict_reused).toBe(true);
    expect(log.difficulty).toBe("medium");
    // Tier reflects the selected expert's actual band.
    expect(log.band).toBe("high");
    expect(log.classifier_time_ms).toBeNull();
    expect(log.route_source).toBe("session");
    const payload = JSON.parse(log.classifier_response);
    expect(payload.verdictReused).toBe(true);
  });

  test("per_turn session policy skips binding reads and writes", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        session_policy: { mode: "per_turn", idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
      })),
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result?.expert.id).toBe("review");
    expect(mocks.expertRoutingSessionBindingDb.getActiveBinding).not.toHaveBeenCalled();
    expect(mocks.expertRoutingSessionBindingDb.createOrSelectBinding).not.toHaveBeenCalled();
  });

  test("legacy config without bands is rejected with a migration hint", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1,
      config: JSON.stringify(config({
        experts: [{ id: "legacy", type: "real", provider_id: "p", model: "m" }],
      })),
    });
    await expect(new ExpertRouter().route(request(), "routing", {}))
      .rejects.toThrow(/no valid band/);
  });
});

describe("ExpertRouter PR-2 fail_open terminal chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue(null);
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({ winner: true, row: {} });
    mocks.providerDb.getById.mockImplementation(async (id: string) => ({ id, name: id }));
    mocks.modelDb.getByProviderId.mockResolvedValue([]);
    mocks.chooseDifficulty.mockRejectedValue(new Error("jev down"));
  });

  test("classifier timeout fails open without retry or latency amplification", async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: "routing", enabled: 1, config: JSON.stringify(config()),
    });
    mocks.chooseDifficulty.mockImplementationOnce(() => new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Jev timeout")), 100),
    ));
    const start = performance.now();
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result?.expert.id).toBe("fast");
    expect(performance.now() - start).toBeLessThan(500);
    expect(mocks.chooseDifficulty).toHaveBeenCalledTimes(1);
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
});
