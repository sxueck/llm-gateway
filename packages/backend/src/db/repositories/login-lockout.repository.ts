import { getDatabase } from "../connection.js";
import type { PoolConnection } from "mysql2/promise";
import type { LoginAttemptLockoutRow, LoginLockoutEventRow } from "../types.js";

export interface LockoutBucket {
  ip: string;
  username: string;
}

/** DB 主键与进程内串行队列共用一份，避免两处定义漂移。 */
export function lockoutBucketKey(ip: string, username: string): string {
  return `${ip}|${username}`;
}

/**
 * 封锁桶 = (ip, username)：共享出口 IP（NAT、未配可信代理的反代）下，
 * 一个用户名的失败不能封锁同一出口里的其它账号。
 * 所有写路径跑在事务里，同桶的读-改-写由行锁跨副本串行。
 */
export const loginLockoutRepository = {
  /** 必须跑在 FOR UPDATE 之前：对不存在的行先取行锁会落入「间隙锁 + INSERT」的死锁形态。 */
  async upsertAttemptRow(
    conn: PoolConnection,
    bucket: LockoutBucket,
    now: number,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO login_attempt_lockouts
         (ip, username, failed_attempts, first_failed_at, last_failed_at, locked_until, updated_at)
       VALUES (?, ?, 0, 0, 0, 0, ?)
       ON DUPLICATE KEY UPDATE ip = ip`,
      [bucket.ip, bucket.username, now],
    );
  },

  /** 锁由调用方持有到事务提交，同桶串行就是这么实现的。 */
  async lockAttemptRow(
    conn: PoolConnection,
    bucket: LockoutBucket,
  ): Promise<LoginAttemptLockoutRow | undefined> {
    const [rows] = await conn.query(
      `SELECT ip, username, failed_attempts, first_failed_at, last_failed_at, locked_until, updated_at
       FROM login_attempt_lockouts WHERE ip = ? AND username = ? FOR UPDATE`,
      [bucket.ip, bucket.username],
    );
    const list = rows as LoginAttemptLockoutRow[];
    return list[0];
  },

  /** 无锁读：登录门禁的快速路径，不阻塞同桶的记账事务。 */
  async getAttemptState(bucket: LockoutBucket): Promise<LoginAttemptLockoutRow | undefined> {
    const conn = await getDatabase().getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ip, username, failed_attempts, first_failed_at, last_failed_at, locked_until, updated_at
         FROM login_attempt_lockouts WHERE ip = ? AND username = ?`,
        [bucket.ip, bucket.username],
      );
      return (rows as LoginAttemptLockoutRow[])[0];
    } finally {
      conn.release();
    }
  },

  async listAttemptStatesByIp(ip: string): Promise<LoginAttemptLockoutRow[]> {
    const conn = await getDatabase().getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ip, username, failed_attempts, first_failed_at, last_failed_at, locked_until, updated_at
         FROM login_attempt_lockouts WHERE ip = ?
         ORDER BY locked_until DESC, last_failed_at DESC
         LIMIT 200`,
        [ip],
      );
      return rows as LoginAttemptLockoutRow[];
    } finally {
      conn.release();
    }
  },

  /** 条件 `locked_until <= ?` 是必需的：成功登录不得清掉校验期间由其它并发失败建立的活跃封锁。 */
  async resetOnSuccess(
    conn: PoolConnection,
    bucket: LockoutBucket,
    now: number,
  ): Promise<number> {
    const [result] = await conn.query(
      `UPDATE login_attempt_lockouts
       SET failed_attempts = 0, first_failed_at = 0, locked_until = 0, updated_at = ?
       WHERE ip = ? AND username = ? AND locked_until <= ?`,
      [now, bucket.ip, bucket.username, now],
    );
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  },

  /** 调用方需已持行锁并完成策略计算，这里只落库。 */
  async updateFailure(
    conn: PoolConnection,
    bucket: LockoutBucket,
    next: Pick<LoginAttemptLockoutRow, "failed_attempts" | "first_failed_at" | "last_failed_at" | "locked_until">,
    now: number,
  ): Promise<void> {
    await conn.query(
      `UPDATE login_attempt_lockouts
       SET failed_attempts = ?, first_failed_at = ?, last_failed_at = ?, locked_until = ?, updated_at = ?
       WHERE ip = ? AND username = ?`,
      [next.failed_attempts, next.first_failed_at, next.last_failed_at, next.locked_until, now, bucket.ip, bucket.username],
    );
  },

  async clearAttemptsByIp(ip: string): Promise<number> {
    const conn = await getDatabase().getConnection();
    try {
      const [result] = await conn.query(
        "DELETE FROM login_attempt_lockouts WHERE ip = ?",
        [ip],
      );
      return (result as { affectedRows?: number }).affectedRows ?? 0;
    } finally {
      conn.release();
    }
  },

  /** 与封锁状态同一事务写入，保证封锁与告警不会只提交一半。 */
  async insertLockoutEvent(
    conn: PoolConnection,
    event: LoginLockoutEventRow,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO login_lockout_events (id, code, ip, username, failed_attempts, locked_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.code, event.ip, event.username, event.failed_attempts, event.locked_until, event.created_at],
    );
  },

  /** 上限是对极端刷封锁场景的有界保护，否则铃铛接口会被事件量撑爆。 */
  async listRecentEvents(
    now: number,
    retentionMs: number,
    limit: number,
  ): Promise<LoginLockoutEventRow[]> {
    const conn = await getDatabase().getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT id, code, ip, username, failed_attempts, locked_until, created_at
         FROM login_lockout_events
         WHERE created_at > ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [now - retentionMs, limit],
      );
      return rows as LoginLockoutEventRow[];
    } finally {
      conn.release();
    }
  },

  /** `locked_until <= now` 是兜底：只要封锁仍活跃，无论 last_failed_at 多旧都不删。 */
  async cleanupAttemptRows(
    now: number,
    retentionMs: number,
    batchSize: number,
    maxBatches = 20,
  ): Promise<number> {
    const conn = await getDatabase().getConnection();
    try {
      const cutoff = now - retentionMs;
      let deleted = 0;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const [result] = await conn.query(
          `DELETE FROM login_attempt_lockouts
           WHERE last_failed_at <= ? AND locked_until <= ?
           LIMIT ?`,
          [cutoff, now, batchSize],
        );
        const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
        deleted += affected;
        if (affected < batchSize) break;
      }
      return deleted;
    } finally {
      conn.release();
    }
  },

  /** 不区分是否已读：否则长期没人读的事件会永不回收。 */
  async cleanupEventRows(
    now: number,
    retentionMs: number,
    batchSize: number,
    maxBatches = 20,
  ): Promise<number> {
    const conn = await getDatabase().getConnection();
    try {
      const cutoff = now - retentionMs;
      let deleted = 0;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const [result] = await conn.query(
          `DELETE FROM login_lockout_events WHERE created_at <= ? LIMIT ?`,
          [cutoff, batchSize],
        );
        const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
        deleted += affected;
        if (affected < batchSize) break;
      }
      return deleted;
    } finally {
      conn.release();
    }
  },
};
