import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectAlerts: vi.fn(),
  getReadCodes: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock("../services/alerts.js", () => ({
  collectAlerts: mocks.collectAlerts,
}));
vi.mock("../db/index.js", () => ({
  alertReadDb: { getReadCodes: mocks.getReadCodes, markRead: mocks.markRead },
}));

import { alertRoutes } from "./alerts.js";

function buildHandlers() {
  const handlers = new Map<string, Function>();
  const fastify = {
    authenticate: vi.fn(),
    addHook: vi.fn(),
    get: vi.fn((path: string, handler: Function) => handlers.set(`GET ${path}`, handler)),
    post: vi.fn((path: string, handler: Function) => handlers.set(`POST ${path}`, handler)),
  };
  return { handlers, fastify };
}

const USER = { userId: "u1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/alerts", () => {
  it("filters out codes already read by the requesting user", async () => {
    mocks.collectAlerts.mockResolvedValue([
      { code: "backup_stale", level: "warning", category: "storage", message: "x" },
      { code: "provider_circuit_open", level: "error", category: "provider", message: "y" },
    ]);
    mocks.getReadCodes.mockResolvedValue(new Set(["backup_stale"]));

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    const response = await handlers.get("GET /")!({ query: {}, user: USER });
    expect(mocks.getReadCodes).toHaveBeenCalledWith("u1");
    expect(response.count).toBe(1);
    expect(response.errors).toBe(1);
    expect(response.alerts.map((a: { code: string }) => a.code)).toEqual([
      "provider_circuit_open",
    ]);
  });
});

describe("POST /admin/alerts/read", () => {
  it("marks the currently active alert codes for the user", async () => {
    mocks.collectAlerts.mockResolvedValue([
      { code: "backup_stale", level: "warning", category: "storage", message: "x" },
      { code: "backup_stale", level: "warning", category: "storage", message: "dup" },
      { code: "provider_circuit_open", level: "error", category: "provider", message: "y" },
    ]);
    mocks.markRead.mockResolvedValue(2);

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    const response = await handlers.get("POST /read")!({ user: USER });
    expect(mocks.markRead).toHaveBeenCalledWith("u1", [
      "backup_stale",
      "backup_stale",
      "provider_circuit_open",
    ]);
    expect(response).toEqual({ marked: 2 });
  });
});
