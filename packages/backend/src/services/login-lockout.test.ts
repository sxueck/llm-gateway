import { beforeEach, describe, expect, test, vi } from "vitest";

// crypto -> config 校验需要的环境变量；登录封锁的反代/豁免网段也在 config 解析，必须在 import 前设好。
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.LOGIN_LOCKOUT_TRUSTED_PROXIES ??= "127.0.0.0/8, 10.0.0.0/8";
  process.env.LOGIN_LOCKOUT_EXEMPT_NETWORKS ??= "198.51.100.7, 2001:db8:e::/64";
});

const harness = await vi.hoisted(async () => {
  const { createFakeLoginDb } = await import("../testing/fake-login-lockout-db.js");
  return createFakeLoginDb() as FakeLoginDbHarness;
});

vi.mock("../db/connection.js", () => ({
  getDatabase: () => harness.pool,
  withTransaction: harness.withTransaction,
}));

vi.mock("../db/index.js", () => ({
  userDb: {
    findByUsername: async (username: string) => {
      const state = harness.state;
      if (state.userLookupDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, state.userLookupDelayMs));
      }
      return state.users.get(username);
    },
  },
}));

import {
  loginLockoutService,
  normalizeClientIp,
  resolveClientIp,
  isLockoutExempt,
  normalizeLockoutUsername,
  buildLockoutEventCode,
  withIpLock,
  ipQueueDepth,
  LOGIN_LOCKOUT_MAX_FAILURES,
  LOGIN_LOCKOUT_DURATION_MS,
  LOGIN_LOCKOUT_QUEUE_LIMIT,
  LOGIN_LOCKOUT_EVENT_RETENTION_MS,
} from "./login-lockout.js";
import { hashPassword } from "../utils/crypto.js";
import { bucketKey, type FakeLoginDbHarness } from "../testing/fake-login-lockout-db.js";
import type { LoginAttemptLockoutRow } from "../db/types.js";

const IP = "203.0.113.7";
const ADMIN_BUCKET = bucketKey(IP, "admin");
const GHOST_BUCKET = bucketKey(IP, "ghost-user");

function seedUser(username = "admin", password = "correct-horse"): void {
  harness.state.users.set(username, {
    id: `user-${username}`,
    username,
    password_hash: hashPassword(password),
  });
}

async function failOnce(username = "admin", password = "wrong", ip = IP) {
  return loginLockoutService.attemptLogin(ip, username, password);
}

beforeEach(() => {
  harness.state.attempts.clear();
  harness.state.events.length = 0;
  harness.state.users.clear();
  harness.state.userLookupDelayMs = 0;
  harness.state.deadlockNextTransaction = false;
  seedUser();
});

describe("normalizeClientIp", () => {
  test("collapses IPv4-mapped IPv6 and loopback aliases to one bucket", () => {
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientIp("::1")).toBe("127.0.0.1");
    expect(normalizeClientIp(" 2001:DB8::A ")).toBe("2001:db8::a");
    expect(normalizeClientIp(undefined)).toBe("unknown");
    expect(normalizeClientIp("x".repeat(100))).toHaveLength(45);
  });
});

describe("buildLockoutEventCode", () => {
  test("is unique per lockout and fits alert_reads.code(64)", () => {
    const codes = new Set(Array.from({ length: 200 }, () => buildLockoutEventCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^login_ip_lockout_[A-Za-z0-9_-]{16}$/);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("失败计数与封锁", () => {
  test("第 5 次失败触发封锁并恰好写入一条事件", async () => {
    for (let i = 1; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) {
      const result = await failOnce();
      expect(result.status).toBe("bad_credentials");
      expect(result.lockoutTriggered).toBeFalsy();
    }
    const fifth = await failOnce();
    expect(fifth.status).toBe("bad_credentials");
    expect(fifth.lockoutTriggered).toBe(true);

    const row = harness.state.attempts.get(ADMIN_BUCKET)!;
    expect(row.failed_attempts).toBe(5);
    expect(row.locked_until).toBeGreaterThan(Date.now());
    expect(row.locked_until - Date.now()).toBeLessThanOrEqual(LOGIN_LOCKOUT_DURATION_MS);
    expect(row.locked_until - Date.now()).toBeGreaterThan(LOGIN_LOCKOUT_DURATION_MS - 10_000);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.events[0].ip).toBe(IP);
    expect(harness.state.events[0].username).toBe("admin");
    expect(harness.state.events[0].failed_attempts).toBe(5);
  });

  test("不存在的用户名同样计数并触发该桶封锁（避免枚举）", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) {
      const result = await loginLockoutService.attemptLogin(IP, "ghost-user", "whatever");
      expect(result.status).toBe("bad_credentials");
    }
    // 与口令无关：这个桶已经被封
    const blocked = await loginLockoutService.attemptLogin(IP, "ghost-user", "whatever");
    expect(blocked.status).toBe("locked");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.events[0].username).toBe("ghost-user");
    expect(harness.state.attempts.get(GHOST_BUCKET)!.failed_attempts).toBe(5);
    // ghost 桶的失败不得封锁同 IP 上的 admin
    expect(harness.state.attempts.get(ADMIN_BUCKET)).toBeUndefined();
    const admin = await loginLockoutService.attemptLogin(IP, "admin", "correct-horse");
    expect(admin.status).toBe("ok");
  });

  test("同一 IP 上不同账号各自计数：admin 被封不阻止其它账号登录", async () => {
    harness.state.users.set("ops", { id: "u2", username: "ops", password_hash: hashPassword("s3cret") });
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    expect((await loginLockoutService.attemptLogin(IP, "admin", "correct-horse")).status).toBe("locked");
    const other = await loginLockoutService.attemptLogin(IP, "ops", "s3cret");
    expect(other.status).toBe("ok");
    expect(other.user?.username).toBe("ops");
  });

  test("封锁期间正确口令也被拒绝且不重置计数", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    const blocked = await loginLockoutService.attemptLogin(IP, "admin", "correct-horse");
    expect(blocked.status).toBe("locked");
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.locked_until).toBeGreaterThan(Date.now());
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(5);
  });

  test("listLockouts 暴露每桶的封锁剩余时间与豁免状态", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    const status = await loginLockoutService.listLockouts(IP);
    expect(status.ip).toBe(IP);
    expect(status.exempt).toBe(false);
    expect(status.buckets).toHaveLength(1);
    expect(status.buckets[0].username).toBe("admin");
    expect(status.buckets[0].locked).toBe(true);
    expect(status.buckets[0].failedAttempts).toBe(5);
    expect(status.buckets[0].retryAfterMs).toBeGreaterThan(0);
  });
});

describe("到期与重置", () => {
  test("封锁到期后凭绝对时间戳解锁并重新计数", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    // 不挂假时钟：直接把截止挑到过去
    const row = harness.state.attempts.get(ADMIN_BUCKET)!;
    row.locked_until = Date.now() - 1;

    const afterExpiry = await failOnce();
    expect(afterExpiry.status).toBe("bad_credentials");
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(1);
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.locked_until).toBe(0);
  });

  test("成功登录安全重置失败计数（不破坏活跃封锁）", async () => {
    for (let i = 0; i < 3; i += 1) await failOnce();
    const ok = await loginLockoutService.attemptLogin(IP, "admin", "correct-horse");
    expect(ok.status).toBe("ok");
    expect(ok.user?.username).toBe("admin");
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(0);

    // 重置后需要再失败 5 次才封锁
    for (let i = 0; i < 4; i += 1) {
      const result = await failOnce();
      expect(result.status).toBe("bad_credentials");
    }
    const status = await loginLockoutService.listLockouts(IP);
    expect(status.buckets[0].locked).toBe(false);
    const fifth = await failOnce();
    expect(fifth.lockoutTriggered).toBe(true);
    expect(harness.state.events).toHaveLength(1);
  });

  test("并发成功路径不会清掉校验期间建立的封锁", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    const lockedUntil = harness.state.attempts.get(ADMIN_BUCKET)!.locked_until;
    const result = await loginLockoutService.attemptLogin(IP, "admin", "correct-horse");
    expect(result.status).toBe("locked");
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.locked_until).toBe(lockedUntil);
  });
});

describe("并发串行化", () => {
  test("同一 IP 的并发失败被串行处理：恰好一次封锁、计数不丢不重", async () => {
    harness.state.userLookupDelayMs = 5; // 放大竞争窗口
    const attempts = Array.from({ length: 8 }, () => failOnce());
    const results = await Promise.all(attempts);

    const bad = results.filter(r => r.status === "bad_credentials");
    const locked = results.filter(r => r.status === "locked");
    expect(bad).toHaveLength(5);
    expect(locked).toHaveLength(3);
    expect(harness.state.events).toHaveLength(1);
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(5);
    expect(harness.state.openConnections).toBe(0);
  });

  test("并发成功登录只发一个 token 且计数清零", async () => {
    for (let i = 0; i < 2; i += 1) await failOnce();
    harness.state.userLookupDelayMs = 5;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        loginLockoutService.attemptLogin(IP, "admin", "correct-horse"),
      ),
    );
    expect(results.every(r => r.status === "ok")).toBe(true);
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(0);
  });

  test("不同 IP 互不影响", async () => {
    harness.state.userLookupDelayMs = 3;
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => failOnce("admin", "wrong", "198.51.100.1")),
      ...Array.from({ length: 5 }, () => failOnce("admin", "wrong", "198.51.100.2")),
    ]);
    expect(results.filter(r => r.lockoutTriggered)).toHaveLength(2);
    expect(await loginLockoutService.attemptLogin("198.51.100.3", "admin", "correct-horse"))
      .toMatchObject({ status: "ok" });
  });

  test("withIpLock 释放后队列清空且失败不阻塞后续", async () => {
    await expect(
      withIpLock(IP, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const value = await withIpLock(IP, async () => 42);
    expect(value).toBe(42);
    expect(ipQueueDepth(IP)).toBe(0);
  });

  test("同桶并发超出上限时直接拒：不入队，也不转嫁延迟", async () => {
    harness.state.userLookupDelayMs = 20; // 拖慢每笔，保证队列一填上去就摸到上限
    const inflight = Array.from({ length: LOGIN_LOCKOUT_QUEUE_LIMIT + 4 }, () => failOnce());
    const results = await Promise.all(inflight);
    // 前 16 笔入队串行记账，后 4 笔摸到上限直接拒（不排队、不占 DB 连接）
    expect(results.filter(r => r.status === "busy")).toHaveLength(4);
    expect(results.filter(r => r.status === "bad_credentials")).toHaveLength(5);
    expect(results.filter(r => r.status === "locked")).toHaveLength(LOGIN_LOCKOUT_QUEUE_LIMIT - 5);
    expect(ipQueueDepth(ADMIN_BUCKET)).toBe(0);
  });

  test("被封锁的桶不必排队即可拒绝（门禁在队列外）", async () => {
    harness.state.userLookupDelayMs = 10;
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    const rejected = await Promise.all(
      Array.from({ length: LOGIN_LOCKOUT_QUEUE_LIMIT + 8 }, () => failOnce("admin", "correct-horse")),
    );
    expect(rejected.every(r => r.status === "locked")).toBe(true);
    expect(rejected.every(r => (r.retryAfterMs ?? 0) > 0)).toBe(true);
    expect(ipQueueDepth(ADMIN_BUCKET)).toBe(0);
  });
});

describe("封锁桶键", () => {
  test("登录名折叠大小写与空白，不让同账号变体分裂计数", () => {
    expect(normalizeLockoutUsername("  Admin  ")).toBe("admin");
    expect(normalizeLockoutUsername("a".repeat(100))).toHaveLength(64);
    expect(bucketKey(IP, normalizeLockoutUsername("ADMIN"))).toBe(ADMIN_BUCKET);
  });

  test("isLockoutExempt 只认配置里的网段与裸 IP", () => {
    expect(isLockoutExempt("198.51.100.7")).toBe(true);
    expect(isLockoutExempt("198.51.100.8")).toBe(false);
    expect(isLockoutExempt("2001:db8:e::1")).toBe(true);
    expect(isLockoutExempt("unknown")).toBe(false);
  });
});

describe("死锁重试", () => {
  test("记账死锁时重试一次并成功", async () => {
    harness.state.deadlockNextTransaction = true;
    const result = await failOnce("admin", "wrong");
    expect(result.status).toBe("bad_credentials");
    expect(harness.state.attempts.get(ADMIN_BUCKET)!.failed_attempts).toBe(1);
    expect(harness.state.openConnections).toBe(0);
  });
});

describe("客户端 IP 归属", () => {
  test("对端不在可信代理网段时完全不读 XFF（转发头可伪造）", () => {
    expect(resolveClientIp("203.0.113.7", "1.1.1.1")).toBe("203.0.113.7");
    expect(resolveClientIp("203.0.113.7", ["1.1.1.1", "2.2.2.2"])).toBe("203.0.113.7");
    expect(resolveClientIp("::ffff:203.0.113.7", undefined)).toBe("203.0.113.7");
  });

  test("对端在可信代理网段内才取 XFF 首项；脏值回落对端", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(resolveClientIp("10.0.0.9", ["198.51.100.4, 203.0.113.9"])).toBe("198.51.100.4");
    expect(resolveClientIp("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(resolveClientIp("::1", "  ")).toBe("127.0.0.1");
  });

  test("登录取的就是 resolveClientIp 的结果：反代后不同客户端不再共用一个封锁桶", async () => {
    // 反代直连对端（127.0.0.1）+ 两个真实客户端 IP
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) {
      await loginLockoutService.attemptLogin(resolveClientIp("127.0.0.1", "203.0.113.11"), "admin", "wrong");
    }
    const blocked = await loginLockoutService.attemptLogin(
      resolveClientIp("127.0.0.1", "203.0.113.11"), "admin", "correct-horse",
    );
    expect(blocked.status).toBe("locked");
    const other = await loginLockoutService.attemptLogin(
      resolveClientIp("127.0.0.1", "203.0.113.12"), "admin", "correct-horse",
    );
    expect(other.status).toBe("ok");
    // 事件记录的是真实客户端 IP，而不是反代地址
    expect((await loginLockoutService.collectAlerts())[0].params?.ip).toBe("203.0.113.11");
  });

  test("豁免网段不参与封锁：连续失败也不锁，且不写尝试行", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES + 2; i += 1) {
      const result = await failOnce("admin", "wrong", "198.51.100.7");
      expect(result.status).toBe("bad_credentials");
    }
    const ok = await loginLockoutService.attemptLogin("198.51.100.7", "admin", "correct-horse");
    expect(ok.status).toBe("ok");
    expect(harness.state.attempts.size).toBe(0);
    expect(harness.state.events).toHaveLength(0);
    expect((await loginLockoutService.listLockouts("198.51.100.7")).exempt).toBe(true);
  });

  test("豁免网段内的错口令仍返回同一 401 文案（不因为豁免而泄露存在性）", async () => {
    const ghost = await loginLockoutService.attemptLogin("198.51.100.7", "no-such-user", "wrong");
    expect(ghost.status).toBe("bad_credentials");
    expect(ghost.user).toBeUndefined();
  });
});

describe("人工解锁后门", () => {
  test("unlockIp 清掉该 IP 的全部封锁桶，listLockouts 能先看到谁被锁", async () => {
    harness.state.users.set("ops", { id: "u2", username: "ops", password_hash: hashPassword("s3cret") });
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce("ops", "bad");

    const before = await loginLockoutService.listLockouts(IP);
    expect(before.buckets.map(b => b.username).sort()).toEqual(["admin", "ops"]);
    expect(before.buckets.every(b => b.locked)).toBe(true);

    expect(await loginLockoutService.unlockIp(IP)).toBe(2);
    expect(harness.state.attempts.size).toBe(0);
    const after = await loginLockoutService.listLockouts(IP);
    expect(after.buckets).toHaveLength(0);
    // 事件是历史事实，解锁不删除已产生的告警
    expect(harness.state.events).toHaveLength(2);
    expect((await loginLockoutService.attemptLogin(IP, "admin", "correct-horse")).status).toBe("ok");
  });
});

describe("告警事件读取", () => {
  test("映射为 security 告警，消息包含 IP 与账号，code 与事件一致", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    const alerts = await loginLockoutService.collectAlerts();
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.category).toBe("security");
    expect(alert.level).toBe("error");
    expect(alert.code).toBe(harness.state.events[0].code);
    expect(alert.message).toContain(IP);
    expect(alert.message).toContain("admin");
    expect(alert.message).toContain("5");
    expect(alert.params).toMatchObject({ ip: IP, username: "admin", attempts: 5 });
    // 时长不写死：前端拿绝对截止时刻自行本地化
    expect(alert.params?.lockedUntil).toBe(harness.state.events[0].locked_until);
  });

  test("只返回保留期内的事件，超出保留期不再展示", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_MAX_FAILURES; i += 1) await failOnce();
    harness.state.events[0].created_at = Date.now() - LOGIN_LOCKOUT_EVENT_RETENTION_MS - 1;
    expect(await loginLockoutService.collectAlerts()).toHaveLength(0);
  });
});

describe("有界清理", () => {
  test("清理过期尝试行但保留活跃封锁", async () => {
    const now = Date.now();
    const seed = (ip: string, row: Partial<LoginAttemptLockoutRow>) => {
      const username = row.username ?? "admin";
      harness.state.attempts.set(bucketKey(ip, username), {
        ip,
        username,
        failed_attempts: 5,
        first_failed_at: now - 1000,
        last_failed_at: now - 1000,
        locked_until: 0,
        updated_at: now,
        ...row,
      });
    };
    seed("1.1.1.1", { locked_until: now + LOGIN_LOCKOUT_DURATION_MS });
    seed("2.2.2.2", {
      last_failed_at: now - 30 * 24 * 3600_000,
      locked_until: now - 29 * 24 * 3600_000,
    });
    seed("3.3.3.3", { failed_attempts: 2, last_failed_at: now - 30 * 24 * 3600_000 });
    // 同 IP 另一账号也处于活跃封锁：清理不得误删
    seed("1.1.1.1", { username: "ops", locked_until: now + LOGIN_LOCKOUT_DURATION_MS });

    const result = await loginLockoutService.cleanup(now);
    expect(result.attempts).toBe(2);
    expect(harness.state.attempts.has(bucketKey("1.1.1.1", "admin"))).toBe(true);
    expect(harness.state.attempts.has(bucketKey("1.1.1.1", "ops"))).toBe(true);
    expect(harness.state.attempts.has(bucketKey("2.2.2.2", "admin"))).toBe(false);
    expect(harness.state.attempts.has(bucketKey("3.3.3.3", "admin"))).toBe(false);
  });

  test("清理过期事件、保留新事件", async () => {
    const now = Date.now();
    const old = {
      id: "old",
      code: "login_ip_lockout_old",
      ip: "1.1.1.1",
      username: "admin",
      failed_attempts: 5,
      locked_until: 1,
      created_at: now - LOGIN_LOCKOUT_EVENT_RETENTION_MS - 5,
    };
    const fresh = { ...old, id: "fresh", code: "login_ip_lockout_fresh", created_at: now - 1000 };
    harness.state.events.push(old, fresh);

    const result = await loginLockoutService.cleanup(now);
    expect(result.events).toBe(1);
    expect(harness.state.events.map(e => e.id)).toEqual(["fresh"]);
  });
});
