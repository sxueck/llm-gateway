import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerDb: { getById: vi.fn(), delete: vi.fn() },
  modelDb: { getByProviderId: vi.fn() },
  virtualKeyDb: { countByModels: vi.fn() },
  invalidateProvider: vi.fn(),
  invalidateModelsByProviderId: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  providerDb: mocks.providerDb,
  modelDb: mocks.modelDb,
  virtualKeyDb: mocks.virtualKeyDb,
}));

vi.mock("../services/hot-config-cache.js", () => ({
  hotConfigCache: {
    invalidateProvider: mocks.invalidateProvider,
    invalidateModelsByProviderId: mocks.invalidateModelsByProviderId,
  },
}));

vi.mock("../utils/crypto.js", () => ({
  encryptApiKey: vi.fn((value: string) => `enc:${value}`),
  decryptApiKey: vi.fn(),
}));

import { mapUpstreamModelList, providerRoutes } from "./providers.js";

function createFastifyStub() {
  const routeMaps = {
    get: new Map<string, Function>(),
    post: new Map<string, Function>(),
    put: new Map<string, Function>(),
    delete: new Map<string, Function>(),
  };
  const fastify: any = {
    authenticate: vi.fn(),
    addHook: vi.fn(),
  };
  for (const method of ["get", "post", "put", "delete"] as const) {
    fastify[method] = vi.fn((path: string, handler: Function) => routeMaps[method].set(path, handler));
  }
  return { routeMaps, fastify };
}

function createReplyStub() {
  const reply: any = {
    statusCode: 200,
    payload: undefined as any,
    code(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.payload = body;
      return reply;
    },
  };
  return reply;
}

describe("mapUpstreamModelList", () => {
  it("preserves capability metadata from upstream model entries", () => {
    const result = mapUpstreamModelList({
      data: [
        {
          id: "gpt-4o",
          object: "model",
          created: 1715367049,
          owned_by: "system",
          max_completion_tokens: 16384,
          context_length: 128000,
        },
      ],
    });

    expect(result).toEqual([
      {
        id: "gpt-4o",
        name: "gpt-4o",
        object: "model",
        created: 1715367049,
        owned_by: "system",
        max_completion_tokens: 16384,
        context_length: 128000,
      },
    ]);
  });

  it("returns an empty list when upstream payload has no data array", () => {
    expect(mapUpstreamModelList({})).toEqual([]);
    expect(mapUpstreamModelList({ data: null })).toEqual([]);
    expect(mapUpstreamModelList(null)).toEqual([]);
  });
});

describe("DELETE /providers/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses deletion while a provider model is referenced by virtual keys", async () => {
    mocks.providerDb.getById.mockResolvedValue({ id: "prov-1" });
    mocks.modelDb.getByProviderId.mockResolvedValue([
      {
        id: "model-1",
        provider_id: "prov-1",
        model_identifier: "gpt-4o",
        name: "GPT-4o",
      },
    ]);
    mocks.virtualKeyDb.countByModels.mockResolvedValue(new Map([["model-1", 2]]));

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.delete.get("/:id")!({ params: { id: "prov-1" } }, reply);

    expect(mocks.virtualKeyDb.countByModels).toHaveBeenCalledWith([
      {
        id: "model-1",
        provider_id: "prov-1",
        model_identifier: "gpt-4o",
        name: "GPT-4o",
      },
    ]);
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toMatchObject({ error: expect.stringContaining("仍被虚拟密钥引用") });
    expect(mocks.providerDb.delete).not.toHaveBeenCalled();
    expect(mocks.invalidateProvider).not.toHaveBeenCalled();
    expect(mocks.invalidateModelsByProviderId).not.toHaveBeenCalled();
  });

  it("deletes the provider when none of its models are referenced", async () => {
    mocks.providerDb.getById.mockResolvedValue({ id: "prov-1" });
    mocks.modelDb.getByProviderId.mockResolvedValue([
      {
        id: "model-1",
        provider_id: "prov-1",
        model_identifier: "gpt-4o",
        name: "GPT-4o",
      },
    ]);
    mocks.virtualKeyDb.countByModels.mockResolvedValue(new Map([["model-1", 0]]));
    mocks.providerDb.delete.mockResolvedValue(undefined);

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response = await routeMaps.delete.get("/:id")!({ params: { id: "prov-1" } }, reply);

    expect(mocks.providerDb.delete).toHaveBeenCalledWith("prov-1");
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("prov-1");
    expect(mocks.invalidateModelsByProviderId).toHaveBeenCalledWith("prov-1");
    expect(reply.statusCode).toBe(200);
    expect(response).toEqual({ success: true });
  });
});
