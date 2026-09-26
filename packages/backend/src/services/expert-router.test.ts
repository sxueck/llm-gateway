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
  modelDb: { getById: vi.fn() },
  chooseExpert: vi.fn(),
}));
vi.mock("../db/index.js", () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
  providerDb: mocks.providerDb,
  modelDb: mocks.modelDb,
}));
vi.mock("./expert-router/jev-client.js", () => ({ chooseExpert: mocks.chooseExpert }));
vi.mock("./expert-router/preprocess/index.js", () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(async (request: any) => ({
      intentText: request.body?.messages?.[0]?.content ?? "route me",
      stats: { promptTokens: 1, cleanedLength: 8 },
    })),
  },
}));

import { ExpertRouter } from "./expert-router.js";
const config = () => ({
  choice_threshold: 0.6,
  experts: [
    { id: "review", category: "review", description: "Review code", type: "real", provider_id: "review", model: "review" },
    { id: "fast", category: "simple", description: "Quick answers", type: "real", provider_id: "fast", model: "fast" },
  ],
  fallback: { type: "real", provider_id: "fallback", model: "fallback" },
  session_binding_policy: { idle_ttl_seconds: 60, absolute_ttl_seconds: 3600 },
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
    mocks.chooseExpert.mockResolvedValue({
      model: "jev-1.13", confidence: 0.8,
      ranked: [{ expertId: "review", probability: 0.8 }, { expertId: "fast", probability: 0.2 }],
    });
  });

  test("chooses highest probability candidate and records ranked probabilities without the prompt", async () => {
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result.expert.id).toBe("review");
    const log = mocks.expertRoutingLogDb.create.mock.calls[0][0];
    expect(log.route_source).toBe("jev");
    expect(log.original_request).toBeUndefined();
    expect(JSON.parse(log.classifier_response).ranked).toEqual([
      { expertId: "review", probability: 0.8 }, { expertId: "fast", probability: 0.2 },
    ]);
  });

  test("uses fallback below probability threshold without invoking another classifier", async () => {
    mocks.chooseExpert.mockResolvedValue({ model: "jev", confidence: 0.5, ranked: [
      { expertId: "review", probability: 0.55 }, { expertId: "fast", probability: 0.45 },
    ] });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result.providerId).toBe("fallback");
    expect(mocks.chooseExpert).toHaveBeenCalledOnce();
  });

  test("tries next candidate when highest-ranked target is unavailable", async () => {
    mocks.providerDb.getById.mockImplementation(async (id: string) => id === "review" ? null : { id, name: id });
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result.expert.id).toBe("fast");
  });

  test("follows the persisted expert when a concurrent session binding wins", async () => {
    mocks.expertRoutingSessionBindingDb.createOrSelectBinding.mockResolvedValue({
      winner: false, row: { expert_id: "fast" },
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result.expert.id).toBe("fast");
    expect(mocks.expertRoutingLogDb.create.mock.calls[0][0].selected_expert_id).toBe("fast");
  });

  test("uses fallback if Jev is unavailable", async () => {
    mocks.chooseExpert.mockRejectedValue(new Error("unavailable"));
    const result = await new ExpertRouter().route(request(), "routing", {});
    expect(result.providerId).toBe("fallback");
  });

  test("reuses a valid session binding without calling Jev", async () => {
    mocks.expertRoutingSessionBindingDb.getActiveBinding.mockResolvedValue({
      expert_id: "review", route_source: "jev",
    });
    const result = await new ExpertRouter().route(request("session"), "routing", {});
    expect(result.expert.id).toBe("review");
    expect(mocks.chooseExpert).not.toHaveBeenCalled();
  });
});
