import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
});

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getByProviderId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  providerGetById: vi.fn(),
  providerGetAll: vi.fn(),
  countByModels: vi.fn(),
  getModelAvailability: vi.fn(),
  routingGetById: vi.fn(),
  withTransaction: vi.fn(async (fn: any) => fn({})),
  invalidateModel: vi.fn(),
  renameModel: vi.fn(async () => () => {}),
  decryptApiKey: vi.fn((value: string) => `plain:${value}`),
  probeModelViaProvider: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  modelDb: {
    getById: mocks.getById,
    getByProviderId: mocks.getByProviderId,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.delete,
    getAll: mocks.getAll,
  },
  providerDb: {
    getById: mocks.providerGetById,
    getAll: mocks.providerGetAll,
  },
  virtualKeyDb: { countByModels: mocks.countByModels },
  apiRequestDb: { getModelAvailability: mocks.getModelAvailability },
  routingConfigDb: { getById: mocks.routingGetById },
  withTransaction: mocks.withTransaction,
}));

vi.mock("../services/hot-config-cache.js", () => ({
  hotConfigCache: { invalidateModel: mocks.invalidateModel },
}));

vi.mock("../services/virtual-key-quota.js", () => ({
  virtualKeyQuota: { renameModel: mocks.renameModel },
}));

vi.mock("../utils/crypto.js", () => ({
  decryptApiKey: mocks.decryptApiKey,
}));

vi.mock("../services/probe-service.js", () => ({
  probeService: { probeModelViaProvider: mocks.probeModelViaProvider },
}));

import { modelRoutes } from "./models.js";

const PROVIDER = {
  id: "prov-1",
  name: "Example",
  base_url: "https://api.example.com",
  protocol_mappings: JSON.stringify({
    anthropic: "https://api.example.com/anthropic",
  }),
  api_key: "enc-key",
};

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "model-1",
    name: "gpt-test",
    provider_id: "prov-1",
    model_identifier: "gpt-test-id",
    is_virtual: 0,
    enabled: 1,
    model_attributes: null,
    routing_config_id: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if ((error as any).validation || error.name === "ZodError") {
      return reply.code(400).send({ error: error.message });
    }
    throw error;
  });
  app.decorate("authenticate", async () => {});
  await modelRoutes(app);
  return app;
}

describe("POST /:id/test probe protocol contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerGetById.mockResolvedValue(PROVIDER);
    mocks.probeModelViaProvider.mockResolvedValue({
      success: true,
      latencyMs: 12,
      protocol: "openai",
    });
  });

  it("returns 404 when the model does not exist", async () => {
    mocks.getById.mockResolvedValue(undefined);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/missing/test",
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "模型不存在" });
    expect(mocks.probeModelViaProvider).not.toHaveBeenCalled();
  });

  it("rejects virtual models before any upstream probe", async () => {
    mocks.getById.mockResolvedValue(makeModel({ is_virtual: 1 }));
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/model-1/test",
      payload: { protocol: "openai" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "虚拟模型无法直接测试" });
    expect(mocks.probeModelViaProvider).not.toHaveBeenCalled();
  });

  it("defaults to the provider's first supported protocol when none is requested", async () => {
    mocks.getById.mockResolvedValue(makeModel());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/model-1/test",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.probeModelViaProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        modelIdentifier: "gpt-test-id",
        protocol: "openai",
        apiKey: "plain:enc-key",
        provider: PROVIDER,
      }),
    );
    expect(response.json()).toMatchObject({ success: true, protocol: "openai" });
  });

  it("honours an explicit protocol the provider offers", async () => {
    mocks.getById.mockResolvedValue(makeModel());
    mocks.probeModelViaProvider.mockResolvedValue({
      success: true,
      latencyMs: 9,
      protocol: "anthropic",
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/model-1/test",
      payload: { protocol: "anthropic" },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.probeModelViaProvider).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "anthropic" }),
    );
    expect(response.json()).toMatchObject({ protocol: "anthropic" });
  });

  it("rejects a protocol the provider does not offer", async () => {
    mocks.getById.mockResolvedValue(makeModel());
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/model-1/test",
      payload: { protocol: "google" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "探测协议必须是供应商提供协议的成员",
    });
    expect(mocks.probeModelViaProvider).not.toHaveBeenCalled();
  });

  it("returns 400 when the provider has no usable protocol", async () => {
    mocks.getById.mockResolvedValue(makeModel());
    mocks.providerGetById.mockResolvedValue({
      ...PROVIDER,
      base_url: "",
      protocol_mappings: null,
    });
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/model-1/test",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "探测协议必须是供应商提供协议的成员",
    });
    expect(mocks.probeModelViaProvider).not.toHaveBeenCalled();
  });
});

describe("POST / modelAttributes create contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerGetById.mockResolvedValue(PROVIDER);
    mocks.create.mockImplementation(async (row: any) => row);
  });

  it("maps deprecated provider alias to litellm_provider and keeps serving metadata", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/",
      payload: {
        name: "cap-model",
        providerId: "prov-1",
        modelIdentifier: "cap-id",
        modelAttributes: {
          provider: "openai",
          max_completion_tokens: 16384,
          context_window: 128000,
          owned_by: "system",
          random_junk: "dropped",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const createdAttrs = JSON.parse(mocks.create.mock.calls[0][0].model_attributes);
    expect(createdAttrs).toEqual({
      litellm_provider: "openai",
      max_completion_tokens: 16384,
      context_window: 128000,
    });
    expect(response.json().modelAttributes).toEqual(createdAttrs);
  });
});
