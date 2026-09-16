import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByServiceTokenHash: vi.fn(),
  virtualKeyGetById: vi.fn(),
  usageGetByRunId: vi.fn(),
  usageUpsert: vi.fn(),
  append: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  agentSearchRunDb: {
    findByServiceTokenHash: mocks.findByServiceTokenHash,
  },
  agentSearchUsageDb: {
    getByRunId: mocks.usageGetByRunId,
    upsert: mocks.usageUpsert,
  },
  virtualKeyDb: {
    getById: mocks.virtualKeyGetById,
  },
}));
vi.mock("../../agent/run/run-events.js", () => ({
  runEventHub: { append: mocks.append },
}));
vi.mock("../../agent/run/scheduler.js", () => ({
  searchRunScheduler: { reportTerminal: vi.fn() },
}));
vi.mock("../../services/cost-mapping.js", () => ({
  costMappingService: { resolveModelCost: vi.fn(async () => undefined) },
}));

import { agentInternalRoutes } from "./internal.js";

const RUN = {
  id: "asr_1",
  status: "running",
  virtual_key_id: "vk-owner",
  model_profile: "search-fast",
  cancellation_requested_at: null,
  expires_at: Date.now() + 60_000,
};

function requestBody() {
  return {
    run_id: "asr_1",
    model_profile: "search-fast",
    turn: 1,
    messages: [{ role: "user", content: "hi" }],
  };
}

async function app() {
  const fastify = Fastify();
  await agentInternalRoutes(fastify);
  return fastify;
}

beforeEach(() => {
  mocks.findByServiceTokenHash.mockResolvedValue(RUN);
  mocks.usageGetByRunId.mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-test",
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  delete process.env.AGENT_INTERNAL_VIRTUAL_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("agent internal completions: 虚拟密钥自动放行", () => {
  it("loopbacks with the run owner's virtual key without AGENT_INTERNAL_VIRTUAL_KEY", async () => {
    mocks.virtualKeyGetById.mockResolvedValue({
      id: "vk-owner",
      key_value: "vk-raw-owner-key",
      enabled: 1,
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/completions",
      headers: { "x-agent-service-token": "stok" },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(String(url)).toContain("/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer vk-raw-owner-key",
    });
    expect(mocks.virtualKeyGetById).toHaveBeenCalledWith("vk-owner");
    await server.close();
  });

  it("rejects with 503 when the owner virtual key is disabled", async () => {
    mocks.virtualKeyGetById.mockResolvedValue({
      id: "vk-owner",
      key_value: "vk-raw-owner-key",
      enabled: 0,
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/completions",
      headers: { "x-agent-service-token": "stok" },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "internal_model_unavailable" },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects with 503 when the run has no owner virtual key", async () => {
    mocks.findByServiceTokenHash.mockResolvedValue({
      ...RUN,
      virtual_key_id: null,
    });
    const server = await app();

    const response = await server.inject({
      method: "POST",
      url: "/completions",
      headers: { "x-agent-service-token": "stok" },
      payload: requestBody(),
    });

    expect(response.statusCode).toBe(503);
    expect(mocks.virtualKeyGetById).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await server.close();
  });
});
