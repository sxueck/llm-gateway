import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PluginStoreError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    PluginStoreError,
    deletePluginVersion: vi.fn(),
    deleteByUserAndPlugin: vi.fn(),
  };
});

vi.mock("../db/index.js", () => ({
  workerPluginDb: { getByIdVersion: vi.fn() },
  userPluginEnrollmentDb: {
    deleteByUserAndPlugin: mocks.deleteByUserAndPlugin,
  },
}));

vi.mock("../agent/plugins/store.js", () => ({
  PluginStoreError: mocks.PluginStoreError,
  deletePluginVersion: mocks.deletePluginVersion,
  listPluginVersions: vi.fn(),
  publishPlugin: vi.fn(),
  setPluginStatus: vi.fn(),
}));

import { workerPluginRoutes } from "./worker-plugins.js";

function buildHandlers() {
  const deletes = new Map<string, Function>();
  const fastify = {
    authenticate: vi.fn(),
    addHook: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn((path: string, handler: Function) =>
      deletes.set(path, handler),
    ),
  };
  return {
    deletes,
    fastify,
    reply: () => ({
      code: vi.fn().mockReturnThis(),
      send: vi.fn(),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /admin/worker-plugins/:id/:version", () => {
  it("returns 404 when the version does not exist", async () => {
    mocks.deletePluginVersion.mockResolvedValue(false);
    const { deletes, fastify, reply } = buildHandlers();
    await workerPluginRoutes(fastify as any);
    const res = reply();

    await deletes.get("/:id/:version")!(
      { params: { id: "com.llm-gateway.x", version: "1.0.0" } },
      res,
    );

    expect(res.code).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith({
      error: {
        message: "plugin com.llm-gateway.x@1.0.0 not found",
        type: "invalid_request_error",
        param: null,
        code: "not_found",
      },
    });
  });

  it("returns 409 with the reason when the version is still in use", async () => {
    mocks.deletePluginVersion.mockRejectedValue(
      new mocks.PluginStoreError(
        "plugin_in_use",
        "plugin com.llm-gateway.x@1.0.0 still has 1 queued or running run(s); finish or cancel them first",
      ),
    );
    const { deletes, fastify, reply } = buildHandlers();
    await workerPluginRoutes(fastify as any);
    const res = reply();

    await deletes.get("/:id/:version")!(
      { params: { id: "com.llm-gateway.x", version: "1.0.0" } },
      res,
    );

    expect(res.code).toHaveBeenCalledWith(409);
    expect(res.send.mock.calls[0][0].error.code).toBe("plugin_in_use");
    expect(res.send.mock.calls[0][0].error.message).toContain(
      "queued or running",
    );
  });

  it("deletes the version and reports it", async () => {
    mocks.deletePluginVersion.mockResolvedValue(true);
    const { deletes, fastify, reply } = buildHandlers();
    await workerPluginRoutes(fastify as any);
    const res = reply();

    await deletes.get("/:id/:version")!(
      { params: { id: "com.llm-gateway.x", version: "1.0.0" } },
      res,
    );

    expect(res.code).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(mocks.deletePluginVersion).toHaveBeenCalledWith(
      "com.llm-gateway.x",
      "1.0.0",
    );
  });
});

describe("DELETE /admin/worker-plugins/enrollments/:pluginId", () => {
  it("requires an authenticated user", async () => {
    const { deletes, fastify, reply } = buildHandlers();
    await workerPluginRoutes(fastify as any);
    const res = reply();

    await deletes.get("/enrollments/:pluginId")!(
      { params: { pluginId: "com.llm-gateway.x" } },
      res,
    );

    expect(res.code).toHaveBeenCalledWith(401);
    expect(mocks.deleteByUserAndPlugin).not.toHaveBeenCalled();
  });

  it("removes the caller's enrollment only", async () => {
    mocks.deleteByUserAndPlugin.mockResolvedValue(true);
    const { deletes, fastify, reply } = buildHandlers();
    await workerPluginRoutes(fastify as any);
    const res = reply();

    const result = await deletes.get("/enrollments/:pluginId")!(
      {
        params: { pluginId: "com.llm-gateway.x" },
        user: { userId: "user-1" },
      },
      res,
    );

    expect(mocks.deleteByUserAndPlugin).toHaveBeenCalledWith(
      "user-1",
      "com.llm-gateway.x",
    );
    expect(result).toEqual({ plugin_id: "com.llm-gateway.x", deleted: true });
  });
});
