import type { LoginAttemptLockoutRow, LoginLockoutEventRow } from "../db/types.js";

/**
 * 登录封锁链路（route -> service -> repository -> SQL）的测试替身：
 * 用内存 Map 实现仓储层实际发出的 SQL 语义，让锁计数/封锁/事件/清理
 * 的行为测试不需要真实 MySQL。
 */
export interface FakeLoginDbUserRow {
  id: string;
  username: string;
  password_hash: string;
}

/** 假库里存放封锁桶的键：只服务于本替身自己的 Map，不依赖生产代码（避开 mock 注入时序）。 */
export function bucketKey(ip: string, username: string): string {
  return `${ip}|${username}`;
}

export interface FakeLoginDbState {
  attempts: Map<string, LoginAttemptLockoutRow>;
  events: LoginLockoutEventRow[];
  users: Map<string, FakeLoginDbUserRow>;
  /** 下一个事务抛一次死锁（ER_LOCK_DEADLOCK），用于验证重试路径 */
  deadlockNextTransaction: boolean;
  /** 下一条查询抛指定错误（非死锁），用于验证登录对存储异常的 fail-closed 收敛 */
  failNextQueryWith: { code: string; message: string } | null;
  /** 模拟跨副本时用户查询的延迟，配合并发用例 */
  userLookupDelayMs: number;
  openConnections: number;
}

export interface FakeLoginDbHarness {
  state: FakeLoginDbState;
  pool: { getConnection(): Promise<unknown> };
  withTransaction<T>(operation: (conn: any) => Promise<T>): Promise<T>;
}

export function createFakeLoginDb(): FakeLoginDbHarness {
  const state: FakeLoginDbState = {
    attempts: new Map(),
    events: [],
    users: new Map(),
    deadlockNextTransaction: false,
    failNextQueryWith: null,
    userLookupDelayMs: 0,
    openConnections: 0,
  };

  const keyOf = (params: any[]): string => bucketKey(params[0], params[1]);

  async function execQuery(sql: string, params: any): Promise<any> {
    if (state.failNextQueryWith) {
      const failure = state.failNextQueryWith;
      state.failNextQueryWith = null;
      throw Object.assign(new Error(failure.message), { code: failure.code });
    }
    const s = sql.trim();
    const list = params as any[];

    if (s.includes("INSERT INTO login_attempt_lockouts") && s.includes("ON DUPLICATE KEY UPDATE ip = ip")) {
      const [ip, username, now] = list;
      const key = bucketKey(ip, username);
      if (!state.attempts.has(key)) {
        state.attempts.set(key, {
          ip,
          username,
          failed_attempts: 0,
          first_failed_at: 0,
          last_failed_at: 0,
          locked_until: 0,
          updated_at: now,
        });
      }
      return { affectedRows: 1 };
    }
    if (s.includes("FROM login_attempt_lockouts WHERE ip = ? AND username = ? FOR UPDATE")) {
      const row = state.attempts.get(keyOf(list));
      return row ? [{ ...row }] : [];
    }
    if (s.includes("FROM login_attempt_lockouts WHERE ip = ? AND username = ?")) {
      const row = state.attempts.get(keyOf(list));
      return row ? [{ ...row }] : [];
    }
    // DELETE 分支必须先于通用 FROM 分支匹配（DELETE 语句同样包含 FROM ...）
    // 人工解锁只带 ip；周期清理带 last_failed_at，两者靠此区分。
    if (s.includes("DELETE FROM login_attempt_lockouts WHERE ip = ?")) {
      const victims = [...state.attempts.values()].filter(row => row.ip === list[0]);
      for (const victim of victims) state.attempts.delete(bucketKey(victim.ip, victim.username));
      return { affectedRows: victims.length };
    }
    if (s.includes("DELETE FROM login_attempt_lockouts")) {
      const [cutoff, now, limit] = list;
      const victims = [...state.attempts.values()]
        .filter(row => row.last_failed_at <= cutoff && row.locked_until <= now)
        .slice(0, limit);
      for (const victim of victims) state.attempts.delete(bucketKey(victim.ip, victim.username));
      return { affectedRows: victims.length };
    }
    if (s.includes("DELETE FROM login_lockout_events")) {
      const [cutoff, limit] = list;
      const victims = state.events.filter(event => event.created_at <= cutoff).slice(0, limit);
      for (const victim of victims) {
        state.events = state.events.filter(event => event !== victim);
      }
      return { affectedRows: victims.length };
    }
    // 必须排在 ip+username 分支之后：那种 SQL 也包含本行子串
    if (s.includes("FROM login_attempt_lockouts WHERE ip = ?")) {
      return [...state.attempts.values()]
        .filter(row => row.ip === list[0])
        .sort((a, b) => b.locked_until - a.locked_until || b.last_failed_at - a.last_failed_at)
        .slice(0, 200)
        .map(row => ({ ...row }));
    }
    // 必须早于通用 UPDATE：重置的 SQL 同时也是 UPDATE
    if (s.includes("SET failed_attempts = 0")) {
      const [now, ip, username] = list;
      const row = state.attempts.get(bucketKey(ip, username));
      if (row && row.locked_until <= now) {
        row.failed_attempts = 0;
        row.first_failed_at = 0;
        row.locked_until = 0;
        row.updated_at = now;
        return { affectedRows: 1 };
      }
      return { affectedRows: 0 };
    }
    if (s.includes("UPDATE login_attempt_lockouts")) {
      const [failed, first, last, lockedUntil, now, ip, username] = list;
      const row = state.attempts.get(bucketKey(ip, username));
      if (!row) throw new Error("fake db: update on missing attempt row");
      row.failed_attempts = failed;
      row.first_failed_at = first;
      row.last_failed_at = last;
      row.locked_until = lockedUntil;
      row.updated_at = now;
      return { affectedRows: 1 };
    }
    if (s.includes("INSERT INTO login_lockout_events")) {
      const [id, code, ip, username, failed, lockedUntil, createdAt] = list;
      if (state.events.some(event => event.code === code)) {
        throw Object.assign(new Error("Duplicate entry for code"), { code: "ER_DUP_ENTRY" });
      }
      state.events.push({
        id,
        code,
        ip,
        username,
        failed_attempts: failed,
        locked_until: lockedUntil,
        created_at: createdAt,
      });
      return { affectedRows: 1 };
    }
    // DELETE 分支已在上面先于通用 FROM 分支匹配完，此处只剩事件读取
    if (s.includes("FROM login_lockout_events")) {
      const [cutoff, limit] = list;
      return state.events
        .filter(event => event.created_at > cutoff)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit)
        .map(event => ({ ...event }));
    }
    throw new Error(`fake db: unexpected SQL: ${s.slice(0, 80)}`);
  }

  function createConnection() {
    state.openConnections += 1;
    const query = async (sql: string, params?: any) => [await execQuery(sql, params)];
    return {
      query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {
        state.openConnections -= 1;
      },
    };
  }

  const pool = {
    getConnection: async () => createConnection(),
  };

  async function withTransaction<T>(operation: (conn: any) => Promise<T>): Promise<T> {
    if (state.deadlockNextTransaction) {
      state.deadlockNextTransaction = false;
      throw Object.assign(new Error("Deadlock found when trying to get lock"), {
        code: "ER_LOCK_DEADLOCK",
      });
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        const result = await operation(conn);
        await conn.commit();
        return result;
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    } finally {
      conn.release();
    }
  }

  return { state, pool, withTransaction };
}
