import type { PoolConnection } from "mysql2/promise";
import { getDatabase, withTransaction } from "../connection.js";

export interface VirtualKeyModelQuotaRow {
  virtualKeyId: string;
  model: string;
  /** 每日 token 上限（单位 M）。 */
  limitMillions: number;
}

export interface VirtualKeyModelUsageDelta {
  usageDate: string;
  virtualKeyId: string;
  model: string;
  consumedTokens: number;
  requestCount: number;
}

/** limitMillions = null 表示删除该模型的额度配置。 */
export interface VirtualKeyQuotaUpsert {
  model: string;
  limitMillions: number | null;
}

/**
 * 虚拟密钥 × 模型每日 token 软配额（issue 39）：主键 (virtual_key_id, model)。
 * 计量单位是客户端请求的模型名（models.name）：虚拟模型和它路由到的真实
 * 模型各自独立，而 api_requests.model 存的是解析后的真实模型，无法区分，
 * 所以必须单独落表。
 */
export const virtualKeyModelQuotaRepository = {
  async getAll(): Promise<VirtualKeyModelQuotaRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT virtual_key_id, model, limit_millions FROM virtual_key_model_quotas",
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        virtualKeyId: String(row.virtual_key_id),
        model: String(row.model),
        limitMillions: Number(row.limit_millions),
      }));
    } finally {
      conn.release();
    }
  },

  async getByVirtualKeyId(
    virtualKeyId: string,
  ): Promise<VirtualKeyModelQuotaRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT virtual_key_id, model, limit_millions FROM virtual_key_model_quotas WHERE virtual_key_id = ?",
        [virtualKeyId],
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        virtualKeyId: String(row.virtual_key_id),
        model: String(row.model),
        limitMillions: Number(row.limit_millions),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * 批量应用额度：只动 entries 里出现的模型（null 删除，数字 upsert），整体一个事务。
   */
  async applyBulk(
    virtualKeyIds: string[],
    entries: VirtualKeyQuotaUpsert[],
    connection?: PoolConnection,
  ): Promise<void> {
    if (virtualKeyIds.length === 0 || entries.length === 0) return;
    const run = async (conn: PoolConnection) => {
      const now = Date.now();
      const removals = entries
        .filter((entry) => entry.limitMillions === null)
        .map((entry) => entry.model);
      if (removals.length > 0) {
        await conn.query(
          `DELETE FROM virtual_key_model_quotas
           WHERE virtual_key_id IN (${virtualKeyIds.map(() => "?").join(", ")})
             AND model IN (${removals.map(() => "?").join(", ")})`,
          [...virtualKeyIds, ...removals],
        );
      }
      const upserts = entries.filter(
        (entry): entry is { model: string; limitMillions: number } =>
          typeof entry.limitMillions === "number",
      );
      if (upserts.length > 0) {
        const values: Array<[string, string, number, number, number]> = [];
        for (const virtualKeyId of virtualKeyIds) {
          for (const entry of upserts) {
            values.push([virtualKeyId, entry.model, entry.limitMillions, now, now]);
          }
        }
        await conn.query(
          `INSERT INTO virtual_key_model_quotas
             (virtual_key_id, model, limit_millions, created_at, updated_at)
           VALUES ${values.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON DUPLICATE KEY UPDATE
             limit_millions = VALUES(limit_millions),
             updated_at = VALUES(updated_at)`,
          values.flat(),
        );
      }
    };
    if (connection) await run(connection);
    else await withTransaction(run);
  },

  /**
   * 模型重命名：把所有虚拟密钥上 `from` 的额度配置改挂到 `to`。
   * 同一密钥两个名字都有配置时 `from`（被改名的一方）胜出，避免额度静默丢失。
   */
  async renameModel(
    from: string,
    to: string,
    connection?: PoolConnection,
  ): Promise<void> {
    const run = async (conn: PoolConnection) => {
      const now = Date.now();
      const [rows] = await conn.query(
        `SELECT virtual_key_id, model, limit_millions
         FROM virtual_key_model_quotas
         WHERE model IN (?, ?)
         ORDER BY virtual_key_id, model
         FOR UPDATE`,
        [from, to],
      );
      const byKey = new Map<string, Map<string, number>>();
      for (const row of rows as Array<Record<string, unknown>>) {
        const key = String(row.virtual_key_id);
        const limits = byKey.get(key) ?? new Map<string, number>();
        limits.set(String(row.model), Number(row.limit_millions));
        byKey.set(key, limits);
      }
      for (const [virtualKeyId, limits] of byKey) {
        const fromLimit = limits.get(from);
        if (fromLimit === undefined) continue;
        if (limits.has(to)) {
          await conn.query(
            "UPDATE virtual_key_model_quotas SET limit_millions = ?, updated_at = ? WHERE virtual_key_id = ? AND model = ?",
            [fromLimit, now, virtualKeyId, to],
          );
          await conn.query(
            "DELETE FROM virtual_key_model_quotas WHERE virtual_key_id = ? AND model = ?",
            [virtualKeyId, from],
          );
        } else {
          await conn.query(
            "UPDATE virtual_key_model_quotas SET model = ?, updated_at = ? WHERE virtual_key_id = ? AND model = ?",
            [to, now, virtualKeyId, from],
          );
        }
      }
    };
    if (connection) await run(connection);
    else await withTransaction(run);
  },
};

/**
 * 虚拟密钥 × 模型 × 网关时区自然日用量表。滚动的当日计数器，只保留当天。
 * 每次 flush 携带稳定 batch id（virtual_key_model_daily_usage_batches 幂等
 * 标记），未知结果的提交可用同一 id 重试而不会重复累计。
 */
export const virtualKeyModelUsageRepository = {
  async addUsage(
    deltas: VirtualKeyModelUsageDelta[],
    batchId: string,
  ): Promise<void> {
    if (deltas.length === 0) return;
    await withTransaction(async (conn) => {
      const [marker] = await conn.query(
        "INSERT IGNORE INTO virtual_key_model_daily_usage_batches (batch_id, created_at) VALUES (?, ?)",
        [batchId, Date.now()],
      );
      if ((marker as { affectedRows: number }).affectedRows === 0) return;

      // 密钥可能在用量还在缓冲时就被删除，级联会连带清掉本表行。若不先筛选，
      // 整批 INSERT 因外键失败会连同幂等标记一起回滚，同批重试次次注定失败。
      // 故在标记占住之后、写入之前筛出仍存在的密钥并 FOR UPDATE 锁父行：并发
      // 删除被阻塞到本事务提交，随后的 INSERT 不可能再违反外键（锁定读总看
      // 最新已提交版本，无快照陈旧窗口）；已删除密钥的用量直接丢弃。
      const keyIds = [...new Set(deltas.map((delta) => delta.virtualKeyId))];
      const [keyRows] = await conn.query(
        `SELECT id FROM virtual_keys WHERE id IN (${keyIds.map(() => "?").join(", ")}) FOR UPDATE`,
        keyIds,
      );
      const alive = new Set(
        (keyRows as Array<Record<string, unknown>>).map((row) =>
          String(row.id),
        ),
      );
      const writable = deltas.filter((delta) => alive.has(delta.virtualKeyId));
      if (writable.length === 0) {
        // 密钥全部已删除：仍提交事务，让幂等标记落库，同 id 的重试立刻变成
        // no-op——而不是把注定失败的载荷永远留在调用方的重试队列里。
        return;
      }

      const now = Date.now();
      const values = writable.map((delta) => [
        delta.usageDate,
        delta.virtualKeyId,
        delta.model,
        delta.consumedTokens,
        delta.requestCount,
        now,
      ]);
      await conn.query(
        `INSERT INTO virtual_key_model_daily_usage
           (usage_date, virtual_key_id, model, consumed_tokens, request_count, updated_at)
         VALUES ${values.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE
           consumed_tokens = consumed_tokens + VALUES(consumed_tokens),
           request_count = request_count + VALUES(request_count),
           updated_at = VALUES(updated_at)`,
        values.flat(),
      );
    });
  },

  async getDayUsage(
    virtualKeyId: string,
    model: string,
    usageDate: string,
  ): Promise<{ consumedTokens: number; requestCount: number }> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT consumed_tokens, request_count FROM virtual_key_model_daily_usage WHERE virtual_key_id = ? AND model = ? AND usage_date = ?",
        [virtualKeyId, model, usageDate],
      );
      const found = (rows as Array<Record<string, unknown>>)[0];
      return {
        consumedTokens: found ? Number(found.consumed_tokens) : 0,
        requestCount: found ? Number(found.request_count) : 0,
      };
    } finally {
      conn.release();
    }
  },

  /** 当天全部 (虚拟密钥, 模型) 行 —— 用来拉回其他实例的流量。 */
  async getDayTotals(
    usageDate: string,
  ): Promise<
    Array<{
      virtualKeyId: string;
      model: string;
      consumedTokens: number;
      requestCount: number;
    }>
  > {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT virtual_key_id, model, consumed_tokens, request_count FROM virtual_key_model_daily_usage WHERE usage_date = ?",
        [usageDate],
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        virtualKeyId: String(row.virtual_key_id),
        model: String(row.model),
        consumedTokens: Number(row.consumed_tokens),
        requestCount: Number(row.request_count),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * 模型重命名：把当天所有密钥的 `from` 用量合并到 `to`，不让重命名静默清零预算。
   */
  async renameDayUsage(
    usageDate: string,
    from: string,
    to: string,
    connection?: PoolConnection,
  ): Promise<void> {
    const run = async (conn: PoolConnection) => {
      const now = Date.now();
      // 两名并存的密钥：合并求和后删旧行，不能覆盖。
      await conn.query(
        `UPDATE virtual_key_model_daily_usage t
         JOIN virtual_key_model_daily_usage f
           ON f.usage_date = t.usage_date
          AND f.virtual_key_id = t.virtual_key_id
          AND f.model = ?
         SET t.consumed_tokens = t.consumed_tokens + f.consumed_tokens,
             t.request_count = t.request_count + f.request_count,
             t.updated_at = ?
         WHERE t.usage_date = ? AND t.model = ?`,
        [from, now, usageDate, to],
      );
      // 只有 from 行的密钥：整行改名（派生表绕开 MySQL 对同表子查询的限制）。
      await conn.query(
        `UPDATE virtual_key_model_daily_usage
         SET model = ?, updated_at = ?
         WHERE usage_date = ? AND model = ?
           AND virtual_key_id NOT IN (
             SELECT virtual_key_id FROM (
               SELECT virtual_key_id FROM virtual_key_model_daily_usage
               WHERE usage_date = ? AND model = ?
             ) AS keys_with_target
           )`,
        [to, now, usageDate, from, usageDate, to],
      );
      // 前两步之后只剩已合并密钥的 from 行，删除收尾。
      await conn.query(
        "DELETE FROM virtual_key_model_daily_usage WHERE usage_date = ? AND model = ?",
        [usageDate, from],
      );
    };
    if (connection) await run(connection);
    else await withTransaction(run);
  },

  async deleteBefore(usageDate: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        "DELETE FROM virtual_key_model_daily_usage WHERE usage_date < ?",
        [usageDate],
      );
      await conn.query(
        "DELETE FROM virtual_key_model_daily_usage_batches WHERE created_at < ?",
        [Date.parse(`${usageDate}T00:00:00+08:00`)],
      );
    } finally {
      conn.release();
    }
  },
};
