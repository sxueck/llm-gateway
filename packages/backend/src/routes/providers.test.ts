import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerDb: { getById: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn(), getAll: vi.fn() },
  modelDb: { getByProviderId: vi.fn() },
  virtualKeyDb: { countByModels: vi.fn() },
  invalidateProvider: vi.fn(),
  invalidateModelsByProviderId: vi.fn(),
  fetchNodePayload: vi.fn(),
  executeProviderTest: vi.fn(),
  fetchModelsLocal: vi.fn(),
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

vi.mock("../services/node-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/node-dispatch.js")>();
  return { ...actual, fetchNodePayload: mocks.fetchNodePayload };
});

vi.mock("../services/node-operations.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/node-operations.js")>();
  return {
    ...actual,
    executeProviderTestLocally: mocks.executeProviderTest,
    fetchUpstreamModelsLocally: mocks.fetchModelsLocal,
  };
});

import { appConfig } from "../config/index.js";
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
    log: { info: vi.fn() },
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

const NODE_ENABLED = {
  enabled: true,
  id: "node-a",
  controlId: "node-a",
  peers: { "node-b": "https://node-b.example.test" },
  secret: "node-test-".repeat(4),
};
let originalNodeConfig: any;

beforeEach(() => {
  originalNodeConfig = appConfig.node;
  // 提供商默认落在已配置的双节点环境，单节点行为由专门用例覆盖。
  appConfig.node = { ...NODE_ENABLED };
});

afterEach(() => {
  appConfig.node = originalNodeConfig;
});

describe("POST /providers (ownerNode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists ownerNode on create and echoes it in the response", async () => {
    mocks.providerDb.getById.mockResolvedValue(undefined);
    mocks.providerDb.create.mockImplementation(async (provider: any) => ({
      ...provider,
      created_at: 1,
      updated_at: 1,
    }));

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.post.get("/")!(
      {
        body: {
          id: "prov-1",
          name: "Prov",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          ownerNode: "node-a",
        },
      },
      reply,
    );

    expect(mocks.providerDb.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "prov-1", owner_node: "node-a" }),
    );
    expect(reply.statusCode).toBe(200);
    expect(response.ownerNode).toBe("node-a");
  });

  it("stores null (default control node) when ownerNode is omitted", async () => {
    mocks.providerDb.getById.mockResolvedValue(undefined);
    mocks.providerDb.create.mockImplementation(async (provider: any) => ({
      ...provider,
      created_at: 1,
      updated_at: 1,
    }));

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.post.get("/")!(
      {
        body: {
          id: "prov-1",
          name: "Prov",
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
        },
      },
      reply,
    );

    expect(mocks.providerDb.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner_node: null }),
    );
    expect(response.ownerNode).toBeNull();
  });

  it("rejects ownerNode with invalid format", async () => {
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    for (const ownerNode of ["Bad_NODE", "1node", "node-上海", "a".repeat(33), ""]) {
      const reply = createReplyStub();
      await routeMaps.post.get("/")!(
        {
          body: {
            id: "prov-1",
            name: "Prov",
            baseUrl: "https://api.example.com/v1",
            apiKey: "sk-test",
            ownerNode,
          },
        },
        reply,
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({ error: { message: expect.any(String), code: "validation_error", type: "invalid_request_error", param: null } });
    }
    expect(mocks.providerDb.create).not.toHaveBeenCalled();
  });
});

describe("PUT /providers/:id (ownerNode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates ownerNode and is not silently stripped", async () => {
    mocks.providerDb.getById
      .mockResolvedValueOnce({ id: "prov-1", owner_node: null })
      .mockResolvedValueOnce({ id: "prov-1", owner_node: "node-b" });
    mocks.providerDb.update.mockResolvedValue(undefined);

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.put.get("/:id")!(
      { params: { id: "prov-1" }, body: { ownerNode: "node-b" } },
      reply,
    );

    expect(mocks.providerDb.update).toHaveBeenCalledWith(
      "prov-1",
      expect.objectContaining({ owner_node: "node-b" }),
    );
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("prov-1");
    expect(reply.statusCode).toBe(200);
    expect(response.ownerNode).toBe("node-b");
  });

  it("clears ownerNode back to null (default control node)", async () => {
    mocks.providerDb.getById
      .mockResolvedValueOnce({ id: "prov-1", owner_node: "node-b" })
      .mockResolvedValueOnce({ id: "prov-1", owner_node: null });
    mocks.providerDb.update.mockResolvedValue(undefined);

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.put.get("/:id")!(
      { params: { id: "prov-1" }, body: { ownerNode: null } },
      reply,
    );

    expect(mocks.providerDb.update).toHaveBeenCalledWith(
      "prov-1",
      expect.objectContaining({ owner_node: null }),
    );
    expect(response.ownerNode).toBeNull();
  });

  it("keeps owner_node untouched when the field is absent from the payload", async () => {
    mocks.providerDb.getById
      .mockResolvedValueOnce({ id: "prov-1", owner_node: "node-b" })
      .mockResolvedValueOnce({ id: "prov-1", owner_node: "node-b" });
    mocks.providerDb.update.mockResolvedValue(undefined);

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.put.get("/:id")!(
      { params: { id: "prov-1" }, body: { name: "New Name" } },
      reply,
    );

    const updates = mocks.providerDb.update.mock.calls[0][1];
    expect(updates).not.toHaveProperty("owner_node");
    expect(response.ownerNode).toBe("node-b");
  });

  it("rejects ownerNode with invalid format on update", async () => {
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.put.get("/:id")!(
      { params: { id: "prov-1" }, body: { ownerNode: "UPPER" } },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(mocks.providerDb.update).not.toHaveBeenCalled();
  });
});

describe("GET /providers (ownerNode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes ownerNode (null default) in list and detail responses", async () => {
    mocks.providerDb.getAll.mockResolvedValue([
      { id: "prov-1", owner_node: "node-a", enabled: 1 },
      { id: "prov-2", owner_node: null, enabled: 1 },
    ]);
    mocks.providerDb.getById.mockResolvedValue({ id: "prov-1", owner_node: "node-a" });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const listReply = createReplyStub();
    const list: any = await routeMaps.get.get("/")!({}, listReply);
    expect(list.providers.map((p: any) => p.ownerNode)).toEqual(["node-a", null]);

    const detailReply = createReplyStub();
    const detail: any = await routeMaps.get.get("/:id")!(
      { params: { id: "prov-1" }, query: {} },
      detailReply,
    );
    expect(detail.ownerNode).toBe("node-a");
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

describe("GET /providers/node-options", () => {
  it("lists only nodes this node can execute", async () => {
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const response: any = await routeMaps.get.get("/node-options")!({}, createReplyStub());

    expect(response).toEqual({
      enabled: true,
      nodeId: "node-a",
      controlId: "node-a",
      nodeIds: ["node-a", "node-b"],
    });
  });

  it("returns an empty list in single-node mode", async () => {
    appConfig.node = { enabled: false, id: "local", controlId: "local", peers: {}, secret: "" };
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    expect(await routeMaps.get.get("/node-options")!({}, createReplyStub())).toMatchObject({
      enabled: false,
      nodeIds: [],
    });
  });
});

describe("ownerNode executability guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const base = {
    id: "prov-1",
    name: "Prov",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
  };

  it("rejects an ownerNode that is not a configured peer", async () => {
    mocks.providerDb.getById.mockResolvedValue(undefined);
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/")!({ body: { ...base, ownerNode: "node-c" } }, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload.error.code).toBe("unknown_owner_node");
    expect(reply.payload.error.message).toContain("node-a, node-b");
    expect(mocks.providerDb.create).not.toHaveBeenCalled();
  });

  it("rejects any explicit owner while node mode is disabled", async () => {
    // 单节点写入显式归属会让该供应商流量永久 503（故障不接管），必须拦在写入。
    appConfig.node = { enabled: false, id: "local", controlId: "local", peers: {}, secret: "" };
    mocks.providerDb.getById.mockResolvedValue(undefined);
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/")!({ body: { ...base, ownerNode: "node-a" } }, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload.error.code).toBe("unknown_owner_node");
    expect(mocks.providerDb.create).not.toHaveBeenCalled();
  });

  it("accepts a configured peer and trims surrounding whitespace", async () => {
    mocks.providerDb.getById.mockResolvedValue(undefined);
    mocks.providerDb.create.mockImplementation(async (provider: any) => provider);
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/")!({ body: { ...base, ownerNode: " node-b " } }, reply);

    expect(reply.statusCode).toBe(200);
    expect(mocks.providerDb.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner_node: "node-b" }),
    );
  });

  it("rejects a batch import before creating any provider", async () => {
    mocks.providerDb.getById.mockResolvedValue(undefined);
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/batch-import")!(
      {
        body: {
          providers: [
            { ...base, ownerNode: "node-b" },
            { ...base, id: "prov-2", ownerNode: "node-c" },
          ],
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.payload.error.code).toBe("unknown_owner_node");
    expect(mocks.providerDb.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown owner on update instead of persisting a dead route", async () => {
    mocks.providerDb.getById.mockResolvedValue({ id: "prov-1", owner_node: "node-b" });
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.put.get("/:id")!({ params: { id: "prov-1" }, body: { ownerNode: "node-c" } }, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload.error.code).toBe("unknown_owner_node");
    expect(mocks.providerDb.update).not.toHaveBeenCalled();
  });
});

describe("POST /providers/:id/test (node owner routing)", () => {
  const CONTROL_NODE = {
    enabled: true,
    id: "node-a",
    controlId: "node-a",
    peers: { "node-b": "http://127.0.0.1:2" },
    secret: "node-test-".repeat(4),
  };
  let originalNodeConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNodeConfig = appConfig.node;
    appConfig.node = { ...CONTROL_NODE };
  });

  afterEach(() => {
    appConfig.node = originalNodeConfig;
  });

  it("forwards the test operation to the owner node and mirrors status/body", async () => {
    mocks.providerDb.getById.mockResolvedValue({
      id: "prov-1",
      owner_node: "node-b",
      base_url: "https://node-b-egress.example.com/v1",
      enabled: 1,
    });
    mocks.fetchNodePayload.mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, status: 200, message: "网络连通", latencyMs: 3 }),
    });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/:id/test")!(
      { params: { id: "prov-1" } },
      reply,
    );

    // 操作只携带 providerId，不携带密钥；目的地只来自 peers 配置
    expect(mocks.fetchNodePayload).toHaveBeenCalledWith(
      "node-b",
      { op: "provider-test", providerId: "prov-1" },
      expect.any(AbortSignal),
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.payload).toEqual({
      success: true,
      status: 200,
      message: "网络连通",
      latencyMs: 3,
    });
    expect(mocks.executeProviderTest).not.toHaveBeenCalled();
  });

  it("does not execute locally when forwarding to the owner fails", async () => {
    mocks.providerDb.getById.mockResolvedValue({
      id: "prov-1",
      owner_node: "node-b",
      base_url: "https://node-b-egress.example.com/v1",
      enabled: 1,
    });
    mocks.fetchNodePayload.mockRejectedValue(
      new Error("owner_node_unconfigured"),
    );

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/:id/test")!(
      { params: { id: "prov-1" } },
      reply,
    );

    expect(reply.statusCode).toBe(503);
    expect(reply.payload.error.code).toBe("owner_node_unavailable");
    expect(mocks.executeProviderTest).not.toHaveBeenCalled();
  });

  it("tests locally when this node owns the provider (null owner defaults to control)", async () => {
    mocks.providerDb.getById.mockResolvedValue({
      id: "prov-1",
      owner_node: null,
      base_url: "https://api.example.com/v1",
      enabled: 1,
    });
    mocks.executeProviderTest.mockResolvedValue({
      success: true,
      message: "网络连通",
      latencyMs: 1,
    });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.post.get("/:id/test")!(
      { params: { id: "prov-1" } },
      reply,
    );

    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(mocks.executeProviderTest).toHaveBeenCalledWith(
      "prov-1",
      "https://api.example.com/v1",
    );
    expect(reply.statusCode).toBe(200);
    expect(response.success).toBe(true);
  });
});

describe("POST /providers/fetch-models (node owner routing)", () => {
  const CONTROL_NODE = {
    enabled: true,
    id: "node-a",
    controlId: "node-a",
    peers: { "node-b": "http://127.0.0.1:2" },
    secret: "node-test-".repeat(4),
  };
  let originalNodeConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNodeConfig = appConfig.node;
    appConfig.node = { ...CONTROL_NODE };
  });

  afterEach(() => {
    appConfig.node = originalNodeConfig;
  });

  it("executes locally when ownerNode resolves to this node (control default)", async () => {
    mocks.fetchModelsLocal.mockResolvedValue({
      success: true,
      message: "成功获取 0 个模型",
      models: [],
    });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    const response: any = await routeMaps.post.get("/fetch-models")!(
      { body: { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", ownerNode: null } },
      reply,
    );

    expect(mocks.fetchModelsLocal).toHaveBeenCalledWith(
      "https://api.example.com/v1",
      "sk-x",
    );
    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(200);
    expect(response.success).toBe(true);
  });

  it("forwards unsaved credentials to the requested owner node only", async () => {
    mocks.fetchNodePayload.mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, message: "成功获取 1 个模型", models: [{ id: "m1", name: "m1" }] }),
    });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/fetch-models")!(
      { body: { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", ownerNode: "node-b" } },
      reply,
    );

    expect(mocks.fetchNodePayload).toHaveBeenCalledWith(
      "node-b",
      { op: "fetch-models", ownerNode: "node-b", baseUrl: "https://api.example.com/v1", apiKey: "sk-x" },
      expect.any(AbortSignal),
    );
    expect(mocks.fetchModelsLocal).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(200);
    expect(reply.payload.models).toEqual([{ id: "m1", name: "m1" }]);
  });

  it("routes ownerNode=null to the control node when running on a peer node", async () => {
    appConfig.node = { ...CONTROL_NODE, id: "node-b", peers: { "node-a": "http://127.0.0.1:1" } };
    mocks.fetchNodePayload.mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({ success: true, message: "成功获取 0 个模型", models: [] }),
    });

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/fetch-models")!(
      { body: { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", ownerNode: null } },
      reply,
    );

    expect(mocks.fetchNodePayload).toHaveBeenCalledWith(
      "node-a",
      expect.objectContaining({ op: "fetch-models", ownerNode: "node-a" }),
      expect.any(AbortSignal),
    );
    expect(mocks.fetchModelsLocal).not.toHaveBeenCalled();
  });

  it("refuses to transmit credentials over a non-private node transport", async () => {
    appConfig.node = { ...CONTROL_NODE, peers: { "node-b": "http://node-b.example.com" } };

    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    const reply = createReplyStub();
    await routeMaps.post.get("/fetch-models")!(
      { body: { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", ownerNode: "node-b" } },
      reply,
    );

    expect(reply.statusCode).toBe(503);
    expect(reply.payload.error.code).toBe("node_transport_insecure");
    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(mocks.fetchModelsLocal).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies with 400 instead of forwarding", async () => {
    const { routeMaps, fastify } = createFastifyStub();
    await providerRoutes(fastify);

    for (const body of [
      { baseUrl: "not-a-url", apiKey: "sk-x" },
      { baseUrl: "https://api.example.com/v1", apiKey: "" },
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", ownerNode: "Bad_NODE" },
      { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", extra: 1 },
    ]) {
      const reply = createReplyStub();
      await routeMaps.post.get("/fetch-models")!({ body }, reply);
      expect(reply.statusCode).toBe(400);
    }
    expect(mocks.fetchNodePayload).not.toHaveBeenCalled();
    expect(mocks.fetchModelsLocal).not.toHaveBeenCalled();
  });
});
