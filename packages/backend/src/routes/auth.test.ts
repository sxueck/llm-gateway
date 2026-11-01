import { beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
});

const harness = await vi.hoisted(async () => {
  const { createFakeLoginDb } = await import("../testing/fake-login-lockout-db.js");
  return createFakeLoginDb();
});

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../db/connection.js", () => ({
  getDatabase: () => harness.pool,
  withTransaction: harness.withTransaction,
}));

vi.mock("../db/index.js", () => ({
  userDb: {
    findByUsername: async (username: string) => harness.state.users.get(username),
  },
  systemConfigDb: { get: async () => undefined, set: async () => {} },
}));

vi.mock("../services/logger.js", () => ({ memoryLogger: logger }));

import { authRoutes } from "./auth.js";
import { hashPassword } from "../utils/crypto.js";
import { bucketKey } from "../testing/fake-login-lockout-db.js";

const IP = "203.0.113.20";
const ADMIN_BUCKET = bucketKey(IP, "admin");
const USER = { id: "u1", username: "admin", password: "correct-horse" };

interface CapturedResponse {
  code: number;
  body: any;
  headers: Record<string, string>;
}

/** 兼容 fastify 的 (path, handler) 与 (path, options, handler) 两种注册写法。 */
function buildApp() {
  const handlers = new Map<string, Function>();
  const register = (method: string) =>
    vi.fn((path: string, optionsOrHandler: Function | object, maybeHandler?: Function) => {
      handlers.set(`${method} ${path}`, typeof maybeHandler === "function" ? maybeHandler : (optionsOrHandler as Function));
    });
  const fastify = {
    jwt: { sign: (payload: any) => `token:${payload.username}` },
    authenticate: vi.fn(),
    post: register("POST"),
    get: register("GET"),
  };
  return { handlers, fastify };
}

function makeReply(capture: { response?: CapturedResponse }) {
  const headers: Record<string, string> = {};
  const reply = {
    code(status: number) {
      return {
        header(name: string, value: string) {
          headers[name] = value;
          return this;
        },
        send(body: any) {
          capture.response = { code: status, body, headers };
          return capture.response;
        },
      };
    },
  };
  return reply;
}

function loginRequest(body: any, ip = IP, headers: Record<string, string> = {}) {
  return { body, ip, headers };
}

async function login(app: ReturnType<typeof buildApp>, body: any, ip = IP, headers: Record<string, string> = {}) {
  const capture: { response?: CapturedResponse } = {};
  const result = await app.handlers.get("POST /login")!(loginRequest(body, ip, headers), makeReply(capture));
  return capture.response ?? { code: 200, body: result, headers: {} };
}

beforeEach(() => {
  harness.state.attempts.clear();
  harness.state.events.length = 0;
  harness.state.users.clear();
  harness.state.failNextQueryWith = null;
  harness.state.deadlockNextTransaction = false;
  harness.state.userLookupDelayMs = 0;
  logger.info.mockClear();
  logger.warn.mockClear();
  harness.state.users.set(USER.username, {
    id: USER.id,
    username: USER.username,
    password_hash: hashPassword(USER.password),
  });
});

describe("POST /api/auth/login 基本行为", () => {
  test("正确口令返回 token 与用户信息", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    const response = await login(app, { username: USER.username, password: USER.password });
    expect(response.code).toBe(200);
    expect(response.body.token).toBe(`token:${USER.username}`);
    expect(response.body.user).toEqual({ id: USER.id, username: USER.username });
    expect(harness.state.attempts.get(ADMIN_BUCKET)?.failed_attempts).toBe(0);
  });

  test("密码错误与用户不存在返回完全一致的 401 文案（防枚举）", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    const wrongPassword = await login(app, { username: USER.username, password: "nope" });
    const noUser = await login(app, { username: "ghost", password: "nope" }, "198.51.100.9");
    expect(wrongPassword.code).toBe(401);
    expect(noUser.code).toBe(401);
    expect(wrongPassword.body).toEqual(noUser.body);
    expect(wrongPassword.body.error).toBe("用户名或密码错误");
  });
});

describe("IP 封锁（5 次失败 / 15 分钟，按账号分桶）", () => {
  test("第 6 次尝试（即便口令正确）被 429 拒绝并带 Retry-After", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    for (let i = 0; i < 5; i += 1) {
      const response = await login(app, { username: USER.username, password: "bad" });
      expect(response.code).toBe(401);
    }
    const blocked = await login(app, { username: USER.username, password: USER.password });
    expect(blocked.code).toBe(429);
    expect(blocked.body.error).toContain("封锁");
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    // RFC 6585：不读 JSON body 的调用方也要能拿到退避时长
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers["Retry-After"])).toBeLessThanOrEqual(900);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.events[0].ip).toBe(IP);
    expect(harness.state.events[0].username).toBe("admin");
  });

  test("同 IP 的另一个账号不受该桶封锁影响（共享出口不跨账号拒绝服务）", async () => {
    harness.state.users.set("ops", { id: "u2", username: "ops", password_hash: hashPassword("s3cret") });
    const app = buildApp();
    await authRoutes(app.fastify as any);
    for (let i = 0; i < 5; i += 1) await login(app, { username: USER.username, password: "bad" });
    expect((await login(app, { username: USER.username, password: USER.password })).code).toBe(429);

    const other = await login(app, { username: "ops", password: "s3cret" });
    expect(other.code).toBe(200);
    expect(other.body.user.username).toBe("ops");
    // 攻击者用变体大小写仍归入同一桶，不能靠改写大小写绕过封锁
    expect((await login(app, { username: "ADMIN", password: USER.password })).code).toBe(429);
  });

  test("不存在的用户名同样计入失败并触发封锁", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    for (let i = 0; i < 5; i += 1) {
      const response = await login(app, { username: "ghost", password: "bad" });
      expect(response.code).toBe(401);
    }
    const blocked = await login(app, { username: USER.username, password: USER.password });
    // ghost 桶被封，admin 桶仍然可用：这正是按账号分桶的目的
    expect(blocked.code).toBe(200);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.events[0].username).toBe("ghost");
  });

  test("对端不是可信代理时，伪造转发头不影响计数归属", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    const spoofed = { "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" };
    for (let i = 0; i < 5; i += 1) {
      await login(app, { username: USER.username, password: "bad" }, "::ffff:203.0.113.20", spoofed);
    }
    // 规范化后按 203.0.113.20 计数，而非转发头里的地址
    expect(harness.state.attempts.has(bucketKey("203.0.113.20", "admin"))).toBe(true);
    expect(harness.state.attempts.has(bucketKey("1.1.1.1", "admin"))).toBe(false);
    const blocked = await login(app, { username: USER.username, password: USER.password });
    expect(blocked.code).toBe(429);
  });

  test("并发失败被串行处理，只产生一次封锁事件", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    harness.state.userLookupDelayMs = 4;
    const responses = await Promise.all(
      Array.from({ length: 7 }, () => login(app, { username: USER.username, password: "bad" })),
    );
    expect(responses.filter(r => r.code === 401)).toHaveLength(5);
    expect(responses.filter(r => r.code === 429)).toHaveLength(2);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.openConnections).toBe(0);
  });
});

describe("封锁存储异常（fail-closed）", () => {
  test("非死锁的 DB 异常收敛成 503 信封并写日志，不放行也不裸 500", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    // 即便口令正确也必须拒绝：异常不得变成绕过封锁的通道
    harness.state.failNextQueryWith = { code: "ER_NO_SUCH_TABLE", message: "Table 'login_attempt_lockouts' doesn't exist" };
    const response = await login(app, { username: USER.username, password: USER.password });
    expect(response.code).toBe(503);
    expect(response.body.error).toBe("登录暂时不可用，请稍后重试");
    expect(response.body.token).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("login_attempt_lockouts");
    expect(logger.warn.mock.calls[0][1]).toBe("Auth");
  });

  test("死锁重试仍正常返回，不被当成存储异常", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    harness.state.deadlockNextTransaction = true;
    const response = await login(app, { username: USER.username, password: USER.password });
    expect(response.code).toBe(200);
  });
});

describe("重置语义", () => {
  test("成功登录清零计数，重新需要 5 次失败才封锁", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    for (let i = 0; i < 3; i += 1) {
      await login(app, { username: USER.username, password: "bad" });
    }
    const ok = await login(app, { username: USER.username, password: USER.password });
    expect(ok.code).toBe(200);
    for (let i = 0; i < 4; i += 1) {
      const response = await login(app, { username: USER.username, password: "bad" });
      expect(response.code).toBe(401);
    }
    const fifth = await login(app, { username: USER.username, password: "bad" });
    expect(fifth.code).toBe(401);
    const blocked = await login(app, { username: USER.username, password: USER.password });
    expect(blocked.code).toBe(429);
    expect(harness.state.events).toHaveLength(1);
  });
});

describe("运维自查/解锁后门", () => {
  const adminUser = { userId: "u1", username: "admin" };

  test("GET /lockouts 需要认证并返回该 IP 的分桶状态", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    expect(app.handlers.get("GET /lockouts")).toBeTypeOf("function");
    for (let i = 0; i < 5; i += 1) await login(app, { username: USER.username, password: "bad" });

    const status = await app.handlers.get("GET /lockouts")!({
      query: { ip: IP },
      user: adminUser,
    });
    expect(status.exempt).toBe(false);
    expect(status.buckets).toHaveLength(1);
    expect(status.buckets[0]).toMatchObject({ username: "admin", locked: true, failedAttempts: 5 });
    expect(status.buckets[0].retryAfterMs).toBeGreaterThan(0);
  });

  test("缺少 ip 参数直接按校验失败抛出", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    await expect(app.handlers.get("GET /lockouts")!({ query: {}, user: adminUser })).rejects.toThrow();
  });

  test("POST /lockouts/unlock 解除封锁并记录操作者，告警事件保留", async () => {
    const app = buildApp();
    await authRoutes(app.fastify as any);
    for (let i = 0; i < 5; i += 1) await login(app, { username: USER.username, password: "bad" });
    expect((await login(app, { username: USER.username, password: USER.password })).code).toBe(429);

    const capture: { response?: CapturedResponse } = {};
    const result = await app.handlers.get("POST /lockouts/unlock")!(
      { body: { ip: IP }, user: adminUser },
      makeReply(capture),
    );
    expect(result).toEqual({ ip: IP, cleared: 1 });
    expect(logger.info.mock.calls[0][0]).toContain(IP);
    expect(logger.info.mock.calls[0][0]).toContain("admin");

    // 解锁后可立即登录；已产生的告警事件是历史事实，不随之消失
    expect((await login(app, { username: USER.username, password: USER.password })).code).toBe(200);
    expect(harness.state.events).toHaveLength(1);
  });
});
