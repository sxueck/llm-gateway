import { nanoid } from "nanoid";
import { BlockList, isIP } from "node:net";
import { appConfig } from "../config/index.js";
import { withTransaction } from "../db/connection.js";
import { userDb } from "../db/index.js";
import {
  loginLockoutRepository,
  lockoutBucketKey,
  type LockoutBucket,
} from "../db/repositories/login-lockout.repository.js";
import { normalizeIp } from "../utils/ip.js";
import { hashPassword, verifyPassword } from "../utils/crypto.js";
import { memoryLogger } from "./logger.js";
import type { SystemAlert } from "./alerts.js";

export const LOGIN_LOCKOUT_MAX_FAILURES = 5;
/** 到期只看绝对时间戳：重启与多副本都不需要恢复计时状态。 */
export const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 与 alert_reads 的已读保留期对齐，告警不会比已读记录活得更久。 */
export const LOGIN_LOCKOUT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_LOCKOUT_EVENT_LIST_LIMIT = 200;
/** 超上限直接拒（不入队），否则洪水把延迟转嫁给同桶的合法登录。 */
export const LOGIN_LOCKOUT_QUEUE_LIMIT = 16;

/** 用户不存在时也用这道占位哈希比一次，抹平用户名存在性的时间侧信道。 */
const TIMING_EQUALIZER_HASH = hashPassword(nanoid());

/** 上限即列宽 64；先折叠大小写再截断，否则同账号变体会分裂计数。 */
const LOCKOUT_USERNAME_MAX_LENGTH = 64;

/** normalizeIp 之上补齐封锁桶的归并要求：小写（IPv6 十六进制不分大小写）、::1→127.0.0.1、空值与列宽。 */
export function normalizeClientIp(ip: string | undefined): string {
  const normalized = normalizeIp(ip ?? "").toLowerCase();
  return (normalized === "::1" ? "127.0.0.1" : normalized || "unknown").slice(0, 45);
}

/**
 * CIDR 列表编译成匹配器，裸 IP 按 /32（IPv6 /128）。非法条目抛错而非静默丢弃：
 * 丢掉一条可信代理等于让可伪造的转发头获得信任，丢掉一条豁免网段等于把运维自己锁在外面。
 */
function compileNetworks(entries: string[], label: string): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of entries) {
    const [network, prefix] = entry.split("/");
    const family = isIP(network);
    if (!family) {
      throw new Error(`登录封锁配置 ${label} 含非法网段: ${entry}`);
    }
    const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 6 ? 128 : 32)) {
      throw new Error(`登录封锁配置 ${label} 含非法前缀长度: ${entry}`);
    }
    list.addSubnet(network, bits, family === 6 ? "ipv6" : "ipv4");
  }
  return (ip: string) => {
    const family = isIP(ip);
    // 'unknown' 等非法地址不参与网段匹配，豁免网段也因此不会意外放行脏值。
    if (!family) return false;
    return list.check(ip, family === 6 ? "ipv6" : "ipv4");
  };
}

const trustedProxyMatcher = compileNetworks(appConfig.loginLockout.trustedProxies, "LOGIN_LOCKOUT_TRUSTED_PROXIES");
const exemptNetworkMatcher = compileNetworks(appConfig.loginLockout.exemptNetworks, "LOGIN_LOCKOUT_EXEMPT_NETWORKS");

/**
 * 只认直连对端地址；仅当对端本身落在 LOGIN_LOCKOUT_TRUSTED_PROXIES 内才采信 XFF 首项。
 * 转发头可任意伪造：无条件的信任既能绕过封锁，也能把全站流量并进同一个封锁桶。
 */
export function resolveClientIp(
  remoteIp: string | undefined,
  forwardedFor?: string | string[],
): string {
  const peer = normalizeClientIp(remoteIp);
  if (!trustedProxyMatcher(peer)) return peer;
  const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const first = normalizeClientIp(raw);
  // 可信代理给出空值/非法值时回落对端，不把它并进 unknown 桶。
  return first === "unknown" ? peer : first;
}

/** 豁免网段 = 运维给自有出口留的后门，不参与封锁。 */
export function isLockoutExempt(ip: string): boolean {
  return exemptNetworkMatcher(normalizeClientIp(ip));
}

/** 折叠后再入桶，避免同一账号的大小写/超长变体各自计数。 */
export function normalizeLockoutUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, LOCKOUT_USERNAME_MAX_LENGTH);
}

export function buildLockoutEventCode(): string {
  // alert_reads.code 上限 64 字符：前缀 17 + nanoid(16) = 33
  return `login_ip_lockout_${nanoid(16)}`;
}

/** 进程内按桶串行；跨副本交给 DB 行锁（FOR UPDATE），两层各管各的边界。 */
const ipQueues = new Map<string, { tail: Promise<unknown>; depth: number }>();

/** 含正在执行的那一笔，门禁据此判断队列是否已满。 */
export function ipQueueDepth(key: string): number {
  return ipQueues.get(key)?.depth ?? 0;
}

export function withIpLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const current = ipQueues.get(key);
  const previous = current?.tail ?? Promise.resolve();
  const run = previous.then(operation, operation);
  ipQueues.set(key, { tail: run, depth: (current?.depth ?? 0) + 1 });
  const release = () => {
    const entry = ipQueues.get(key);
    if (!entry) return;
    entry.depth -= 1;
    // 只有队尾仍是自己且已无人排队时才清理，防止清掉后来排队的新请求
    if (entry.depth <= 0 && entry.tail === run) ipQueues.delete(key);
  };
  run.then(release, release);
  return run;
}

export type LoginAttemptStatus = "ok" | "bad_credentials" | "locked" | "busy";

export interface LoginAttemptResult {
  status: LoginAttemptStatus;
  user?: { id: string; username: string };
  /** 仅 status === locked 时有值 */
  retryAfterMs?: number;
  /** 本次失败是否刚好跨过封锁阈值 */
  lockoutTriggered?: boolean;
}

function isDeadlock(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT";
}

interface VerifiedAttempt {
  user?: { id: string; username: string };
  verified: boolean;
}

async function verifyCredentials(username: string, password: string): Promise<VerifiedAttempt> {
  const user = await userDb.findByUsername(username);
  const verified = verifyPassword(password, user?.password_hash ?? TIMING_EQUALIZER_HASH);
  return { user: user ? { id: user.id, username: user.username } : undefined, verified };
}

async function attemptLoginOnce(
  bucket: LockoutBucket,
  username: string,
  password: string,
): Promise<LoginAttemptResult> {
  const checked = await verifyCredentials(username, password);

  return withTransaction(async (conn) => {
    // 重新取时：口令校验与一次用户查询可能已隔了若干毫秒，到期判定只看当下
    const recordNow = Date.now();
    await loginLockoutRepository.upsertAttemptRow(conn, bucket, recordNow);
    const row = await loginLockoutRepository.lockAttemptRow(conn, bucket);
    if (!row) {
      throw new Error("login lockout row missing after upsert");
    }
    // 复核：校验期间其它并发失败可能已建立封锁
    if (row.locked_until > recordNow) {
      return { status: "locked", retryAfterMs: row.locked_until - recordNow } as LoginAttemptResult;
    }

    if (checked.verified && checked.user) {
      await loginLockoutRepository.resetOnSuccess(conn, bucket, recordNow);
      return { status: "ok", user: checked.user };
    }

    // locked_until > 0 = 上一轮封锁真实发生过，到期后另起新一轮计数
    const freshEpisode = row.locked_until > 0;
    const failedAttempts = freshEpisode ? 1 : row.failed_attempts + 1;
    const locked = failedAttempts >= LOGIN_LOCKOUT_MAX_FAILURES;
    const lockedUntil = locked ? recordNow + LOGIN_LOCKOUT_DURATION_MS : 0;
    await loginLockoutRepository.updateFailure(
      conn,
      bucket,
      {
        failed_attempts: failedAttempts,
        first_failed_at: freshEpisode || row.failed_attempts === 0 ? recordNow : row.first_failed_at,
        last_failed_at: recordNow,
        locked_until: lockedUntil,
      },
      recordNow,
    );

    let lockoutTriggered = false;
    if (locked) {
      // 只在跨过阈值那一笔写事件：否则封锁期间每次失败都会刷出一条新告警
      await loginLockoutRepository.insertLockoutEvent(conn, {
        id: nanoid(),
        code: buildLockoutEventCode(),
        ip: bucket.ip,
        username: bucket.username,
        failed_attempts: failedAttempts,
        locked_until: lockedUntil,
        created_at: recordNow,
      });
      lockoutTriggered = true;
      memoryLogger.warn(
        `IP ${bucket.ip} 账号 ${bucket.username} 连续 ${failedAttempts} 次登录失败，已封锁 ${LOGIN_LOCKOUT_DURATION_MS / 60000} 分钟`,
        "LoginLockout",
      );
    }
    return { status: "bad_credentials", lockoutTriggered };
  });
}

export const loginLockoutService = {
  /**
   * 死锁/锁等待只重试一次：那是多副本同桶并发首写的罕见竞争，重试更多只会放大故障。
   * 其余异常直接上抛，由登录路由 fail-closed 处理。
   */
  async attemptLogin(ip: string, username: string, password: string): Promise<LoginAttemptResult> {
    const bucket: LockoutBucket = { ip: normalizeClientIp(ip), username: normalizeLockoutUsername(username) };

    // 豁免网段不记账，但口令照常校验：对外行为与未启用封锁时一致
    if (isLockoutExempt(bucket.ip)) {
      const checked = await verifyCredentials(username, password);
      return checked.verified && checked.user
        ? { status: "ok", user: checked.user }
        : { status: "bad_credentials" };
    }

    // 门禁在队列外：已封锁的桶不必排队，直接拒
    const gate = await loginLockoutRepository.getAttemptState(bucket);
    const now = Date.now();
    if (gate && gate.locked_until > now) {
      return { status: "locked", retryAfterMs: gate.locked_until - now };
    }

    const key = lockoutBucketKey(bucket.ip, bucket.username);
    if (ipQueueDepth(key) >= LOGIN_LOCKOUT_QUEUE_LIMIT) {
      memoryLogger.warn(
        `登录封锁队列已满（${key}，上限 ${LOGIN_LOCKOUT_QUEUE_LIMIT}），拒绝本次并发尝试`,
        "LoginLockout",
      );
      return { status: "busy" };
    }

    return withIpLock(key, async () => {
      try {
        return await attemptLoginOnce(bucket, username, password);
      } catch (error) {
        if (isDeadlock(error)) {
          memoryLogger.warn(`登录封锁记账遇到锁竞争，重试一次: ${(error as Error).message}`, "LoginLockout");
          return attemptLoginOnce(bucket, username, password);
        }
        throw error;
      }
    });
  },

  /** 运维自查：该 IP 上每个桶的封锁明细。 */
  async listLockouts(ip: string): Promise<{
    ip: string;
    exempt: boolean;
    buckets: Array<{
      username: string;
      failedAttempts: number;
      locked: boolean;
      lockedUntil: number;
      retryAfterMs: number;
    }>;
  }> {
    const normalized = normalizeClientIp(ip);
    const now = Date.now();
    const rows = await loginLockoutRepository.listAttemptStatesByIp(normalized);
    return {
      ip: normalized,
      exempt: isLockoutExempt(normalized),
      buckets: rows.map(row => ({
        username: row.username,
        failedAttempts: row.failed_attempts,
        locked: row.locked_until > now,
        lockedUntil: row.locked_until,
        retryAfterMs: row.locked_until > now ? row.locked_until - now : 0,
      })),
    };
  },

  /** 只清封锁状态；告警事件是已发生的历史事实，不随之删除。 */
  async unlockIp(ip: string): Promise<number> {
    return loginLockoutRepository.clearAttemptsByIp(normalizeClientIp(ip));
  },

  /** 直读库、每次实时取：告警生命周期由事件行决定，不走快照缓存（30s）那条路径。 */
  async collectAlerts(now: number = Date.now()): Promise<SystemAlert[]> {
    const events = await loginLockoutRepository.listRecentEvents(
      now,
      LOGIN_LOCKOUT_EVENT_RETENTION_MS,
      LOGIN_LOCKOUT_EVENT_LIST_LIMIT,
    );
    return events.map(event => ({
      code: event.code,
      level: "error" as const,
      category: "security" as const,
      message: `IP ${event.ip} 账号 ${event.username} 连续 ${event.failed_attempts} 次登录失败，已封锁至 ${new Date(event.locked_until).toISOString()}`,
      params: {
        ip: event.ip,
        username: event.username,
        attempts: event.failed_attempts,
        lockedUntil: event.locked_until,
      },
    }));
  },

  async cleanup(now: number = Date.now()): Promise<{ attempts: number; events: number }> {
    const attempts = await loginLockoutRepository.cleanupAttemptRows(
      now,
      LOGIN_ATTEMPT_RETENTION_MS,
      500,
    );
    const events = await loginLockoutRepository.cleanupEventRows(
      now,
      LOGIN_LOCKOUT_EVENT_RETENTION_MS,
      500,
    );
    return { attempts, events };
  },
};

/** unref：不让定时器阻止进程退出。 */
let cleanupTimer: NodeJS.Timeout | null = null;

export function startLoginLockoutCleanup(intervalMs: number = 60 * 60 * 1000): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    loginLockoutService.cleanup().catch((error: unknown) => {
      memoryLogger.warn(`登录封锁清理失败: ${error}`, "LoginLockout");
    });
  }, intervalMs);
  cleanupTimer.unref();
}
