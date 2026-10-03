import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ providers: vi.fn(), forward: vi.fn() }));
vi.mock("../db/index.js", () => ({ providerDb: { getAll: mocks.providers } }));
vi.mock("../services/node-operations.js", () => ({ forwardNodeOperation: mocks.forward }));

import { appConfig } from "../config/index.js";
import { nodeAdminRoutes } from "./nodes.js";

const config = {
  enabled: true, id: "node-a", controlId: "node-a",
  peers: { "node-b": "https://node-b.example.test" }, secret: "node-secret-".repeat(4),
};
const original = appConfig.node;

beforeEach(() => {
  vi.resetAllMocks();
  appConfig.node = { ...config };
  mocks.providers.mockResolvedValue([
    { id: "p1", name: "Default", owner_node: null, enabled: 1, api_key: "private-api-key" },
    { id: "p2", name: "Remote", owner_node: "node-b", enabled: 0 },
    { id: "p3", name: "Unconfigured", owner_node: "old-node", enabled: 1 },
  ]);
  mocks.forward.mockResolvedValue({ status: 200, body: { enabled: true, nodeId: "node-b", controlId: "node-a" } });
});
afterEach(() => { appConfig.node = original; });

async function createApp(authenticated = true) {
  const app = Fastify();
  app.decorate("authenticate", async (_request: unknown, reply: any) => {
    if (!authenticated) return reply.code(401).send({ error: { code: "unauthorized" } });
  });
  await app.register(nodeAdminRoutes, { prefix: "/api/admin/nodes" });
  return app;
}

async function inject(url: string, method: "GET" | "POST" = "GET", authenticated = true) {
  const app = await createApp(authenticated);
  try { return await app.inject({ method, url }); }
  finally { await app.close(); }
}

describe("node diagnostics admin API", () => {
  it("requires authentication before overview or checks", async () => {
    expect((await inject("/api/admin/nodes", "GET", false)).statusCode).toBe(401);
    expect((await inject("/api/admin/nodes/node-b/check", "POST", false)).statusCode).toBe(401);
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("lists configured nodes and ownership without exposing secrets", async () => {
    const response = await inject("/api/admin/nodes");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true, nodeId: "node-a", controlId: "node-a",
      nodes: [
        { id: "node-a", origin: null, local: true, control: true },
        { id: "node-b", origin: "https://node-b.example.test", local: false, control: false },
      ],
      providers: [
        { id: "p1", name: "Default", ownerNode: "node-a", enabled: true, configured: true },
        { id: "p2", name: "Remote", ownerNode: "node-b", enabled: false, configured: true },
        { id: "p3", name: "Unconfigured", ownerNode: "old-node", enabled: true, configured: false },
      ],
    });
    expect(response.body).not.toContain("node-secret-");
    expect(response.body).not.toContain("private-api-key");
  });

  it("returns disabled overview and refuses checks without contacting peers", async () => {
    appConfig.node = { enabled: false, id: "local", controlId: "local", peers: {}, secret: "" };
    expect((await inject("/api/admin/nodes")).json()).toEqual({ enabled: false, nodeId: "local", controlId: "local", nodes: [], providers: [] });
    const response = await inject("/api/admin/nodes/node-b/check", "POST");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("node_mode_disabled");
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("refuses arbitrary probe targets", async () => {
    const unknown = await inject("/api/admin/nodes/attacker/check", "POST");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("node_not_found");
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("reports local without claiming remote authentication", async () => {
    expect((await inject("/api/admin/nodes/node-a/check", "POST")).json()).toMatchObject({ nodeId: "node-a", reachable: true, authenticated: null, errorCode: null });
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("uses the signed health operation and validates identity", async () => {
    const result = (await inject("/api/admin/nodes/node-b/check", "POST")).json();
    expect(result).toMatchObject({ nodeId: "node-b", reachable: true, authenticated: true, errorCode: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(mocks.forward).toHaveBeenCalledWith("node-b", { op: "node-health" }, 8000);
    mocks.forward.mockResolvedValue({ status: 200, body: { enabled: true, nodeId: "wrong-node", controlId: "node-a" } });
    expect((await inject("/api/admin/nodes/node-b/check", "POST")).json()).toMatchObject({ reachable: true, authenticated: false, errorCode: "node_health_mismatch" });
  });

  it("does not misreport peer saturation as failed authentication", async () => {
    mocks.forward.mockResolvedValue({ status: 503, body: { error: { code: "node_dispatch_saturated" } } });
    expect((await inject("/api/admin/nodes/node-b/check", "POST")).json()).toMatchObject({
      reachable: true, authenticated: null, errorCode: "node_dispatch_saturated",
    });
  });

  it("deduplicates in-flight manual checks", async () => {
    let finish!: (value: unknown) => void;
    mocks.forward.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const app = await createApp();
    try {
      const requests = [app.inject({ method: "POST", url: "/api/admin/nodes/node-b/check" }), app.inject({ method: "POST", url: "/api/admin/nodes/node-b/check" })];
      const running = Promise.all(requests);
      await vi.waitFor(() => expect(mocks.forward).toHaveBeenCalledTimes(1));
      finish({ status: 200, body: { enabled: true, nodeId: "node-b", controlId: "node-a" } });
      const results = await running;
      expect(results[0].json()).toEqual(results[1].json());
    } finally { await app.close(); }
  });

  it.each([
    [new Error("peer_node_auth_failed"), true, false, "peer_node_auth_failed"],
    [new Error("owner_node_unavailable"), null, null, "owner_node_unavailable"],
    [Object.assign(new Error("timeout"), { name: "AbortError" }), null, null, "node_check_timeout"],
  ])("reports failures without guessing connectivity or leaking errors", async (error, reachable, authenticated, errorCode) => {
    mocks.forward.mockRejectedValue(error);
    expect((await inject("/api/admin/nodes/node-b/check", "POST")).json()).toMatchObject({ reachable, authenticated, errorCode });
  });

  it("uses the error envelope for database failures", async () => {
    mocks.providers.mockRejectedValue(new Error("private-database-error"));
    const response = await inject("/api/admin/nodes");
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("node_overview_failed");
    expect(response.body).not.toContain("private-database-error");
  });
});
