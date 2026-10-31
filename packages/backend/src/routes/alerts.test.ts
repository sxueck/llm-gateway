import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectAlerts: vi.fn(),
  getReadCodes: vi.fn(),
  markRead: vi.fn(),
  collectLockoutAlerts: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../services/alerts.js", () => ({
  collectAlerts: mocks.collectAlerts,
  // 路由从采集层复用同一份级别排序表，mock 里也得给出真值。
  ALERT_LEVEL_ORDER: { error: 0, warning: 1, info: 2 },
}));
vi.mock("../db/index.js", () => ({
  alertReadDb: { getReadCodes: mocks.getReadCodes, markRead: mocks.markRead },
}));
vi.mock("../services/logger.js", () => ({
  memoryLogger: { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/login-lockout.js", () => ({
  loginLockoutService: { collectAlerts: mocks.collectLockoutAlerts },
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

const LOCKOUT_ALERT = {
  code: "login_ip_lockout_abc123",
  level: "error",
  category: "security",
  message: "IP 203.0.113.7 账号 admin 连续 5 次登录失败，已封锁至 2025-01-01T00:15:00.000Z",
  params: { ip: "203.0.113.7", username: "admin", attempts: 5, lockedUntil: 1_735_689_300_000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectLockoutAlerts.mockResolvedValue([]);
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

  it("merges persisted security lockout events outside the snapshot cache", async () => {
    mocks.collectAlerts.mockResolvedValue([
      { code: "backup_stale", level: "warning", category: "storage", message: "x" },
    ]);
    mocks.collectLockoutAlerts.mockResolvedValue([LOCKOUT_ALERT]);
    mocks.getReadCodes.mockResolvedValue(new Set());

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    const response = await handlers.get("GET /")!({ query: {}, user: USER });
    // security 事件每次实时读库，与快照告警合并后按级别排序
    expect(mocks.collectLockoutAlerts).toHaveBeenCalledTimes(1);
    expect(response.alerts.map((a: { code: string }) => a.code)).toEqual([
      "login_ip_lockout_abc123",
      "backup_stale",
    ]);
    expect(response.errors).toBe(1);
  });

  it("hides a lockout alert once that user read it, independently of other users", async () => {
    mocks.collectAlerts.mockResolvedValue([]);
    mocks.collectLockoutAlerts.mockResolvedValue([LOCKOUT_ALERT]);
    mocks.getReadCodes.mockResolvedValue(new Set(["login_ip_lockout_abc123"]));

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    const response = await handlers.get("GET /")!({ query: {}, user: USER });
    expect(response.count).toBe(0);
    expect(response.alerts).toEqual([]);
  });

  it("keeps a lockout alert visible until read even though the lock expired (persistence, not snapshot)", async () => {
    mocks.collectAlerts.mockResolvedValue([]);
    mocks.collectLockoutAlerts.mockResolvedValue([LOCKOUT_ALERT]);
    mocks.getReadCodes.mockResolvedValue(new Set());

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    // 快照缓存命中与否不影响 security 事件的读取路径
    const response = await handlers.get("GET /")!({ query: { fresh: "0" }, user: USER });
    expect(response.alerts).toHaveLength(1);
  });

  it("drops only the security events when the lockout table read fails (bell keeps working)", async () => {
    mocks.collectAlerts.mockResolvedValue([
      { code: "backup_stale", level: "warning", category: "storage", message: "x" },
      { code: "provider_circuit_open", level: "error", category: "provider", message: "y" },
    ]);
    mocks.collectLockoutAlerts.mockRejectedValue(new Error("ER_NO_SUCH_TABLE: table missing"));
    mocks.getReadCodes.mockResolvedValue(new Set());

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    // 本模块的不变量：一次 DB 抖动不能让铃铛整体失灵（services/alerts.ts runChecks 同款兜底）
    const response = await handlers.get("GET /")!({ query: {}, user: USER });
    expect(response.alerts.map((a: { code: string }) => a.code)).toEqual([
      "provider_circuit_open",
      "backup_stale",
    ]);
    expect(response.count).toBe(2);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn.mock.calls[0][0]).toContain("ER_NO_SUCH_TABLE");
  });

  it("marks security events read even when their read path failed for the GET", async () => {
    mocks.collectAlerts.mockResolvedValue([{ code: "backup_stale", level: "warning", category: "storage", message: "x" }]);
    mocks.collectLockoutAlerts
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue([LOCKOUT_ALERT]);
    mocks.markRead.mockResolvedValue(2);

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    await handlers.get("GET /")!({ query: {}, user: USER });
    const response = await handlers.get("POST /read")!({ user: USER });
    expect(mocks.markRead).toHaveBeenCalledWith("u1", ["login_ip_lockout_abc123", "backup_stale"]);
    expect(response).toEqual({ marked: 2 });
  });
});

describe("POST /admin/alerts/read", () => {
  it("marks the currently active alert codes (snapshot + persisted security) for the user", async () => {
    mocks.collectAlerts.mockResolvedValue([
      { code: "backup_stale", level: "warning", category: "storage", message: "x" },
      { code: "backup_stale", level: "warning", category: "storage", message: "dup" },
      { code: "provider_circuit_open", level: "error", category: "provider", message: "y" },
    ]);
    mocks.collectLockoutAlerts.mockResolvedValue([LOCKOUT_ALERT]);
    mocks.markRead.mockResolvedValue(3);

    const { handlers, fastify } = buildHandlers();
    await alertRoutes(fastify as any);

    const response = await handlers.get("POST /read")!({ user: USER });
    expect(mocks.markRead).toHaveBeenCalledWith("u1", [
      "provider_circuit_open",
      "login_ip_lockout_abc123",
      "backup_stale",
      "backup_stale",
    ]);
    expect(response).toEqual({ marked: 3 });
  });
});
