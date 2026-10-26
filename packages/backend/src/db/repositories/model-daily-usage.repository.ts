import type { PoolConnection } from "mysql2/promise";
import { getDatabase, withTransaction } from "../connection.js";

export interface ModelDailyUsageRow {
  usageDate: string;
  /** Addressed model name (`models.name`) — the quota unit. */
  model: string;
  consumedTokens: number;
  requestCount: number;
}

/**
 * Per-model daily token counter backing the model daily quota.
 *
 * Rows are keyed by the model the client addressed (`models.name`), so a
 * virtual model keeps its own budget instead of merging into the real model it
 * routes to (api_requests.model stores the resolved real model and cannot
 * distinguish them). Each flush has a stable batch id, so retrying an unknown
 * commit outcome cannot apply the same deltas twice.
 */
export const modelDailyUsageRepository = {
  async addUsage(deltas: ModelDailyUsageRow[], batchId: string): Promise<void> {
    if (deltas.length === 0) return;
    await withTransaction(async (conn) => {
      const [marker] = await conn.query(
        "INSERT IGNORE INTO model_daily_usage_batches (batch_id, created_at) VALUES (?, ?)",
        [batchId, Date.now()],
      );
      if ((marker as { affectedRows: number }).affectedRows === 0) return;

      const now = Date.now();
      const values = deltas.map((delta) => [
        delta.usageDate,
        delta.model,
        delta.consumedTokens,
        delta.requestCount,
        now,
      ]);
      await conn.query(
        `INSERT INTO model_daily_usage
           (usage_date, model, consumed_tokens, request_count, updated_at)
         VALUES ${values.map(() => "(?, ?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE
           consumed_tokens = consumed_tokens + VALUES(consumed_tokens),
           request_count = request_count + VALUES(request_count),
           updated_at = VALUES(updated_at)`,
        values.flat(),
      );
    });
  },

  async getDayUsage(
    model: string,
    usageDate: string,
  ): Promise<{ consumedTokens: number; requestCount: number }> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT consumed_tokens, request_count FROM model_daily_usage WHERE model = ? AND usage_date = ?",
        [model, usageDate],
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

  /** Today's totals for every model with a row — used to refresh the shared count. */
  async getDayTotals(usageDate: string): Promise<Array<{ model: string; consumedTokens: number; requestCount: number }>> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT model, consumed_tokens, request_count FROM model_daily_usage WHERE usage_date = ?",
        [usageDate],
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        model: String(row.model),
        consumedTokens: Number(row.consumed_tokens),
        requestCount: Number(row.request_count),
      }));
    } finally {
      conn.release();
    }
  },

  /** Carry a day's counter to a renamed model so its usage is not reset. */
  async renameDayUsage(
    usageDate: string,
    from: string,
    to: string,
    connection?: PoolConnection,
  ): Promise<void> {
    const rename = async (conn: PoolConnection) => {
      const [rows] = await conn.query(
        `SELECT model, consumed_tokens, request_count
         FROM model_daily_usage
         WHERE usage_date = ? AND model IN (?, ?)
         ORDER BY model
         FOR UPDATE`,
        [usageDate, from, to],
      );
      const byModel = new Map(
        (rows as Array<Record<string, unknown>>).map((row) => [
          String(row.model),
          {
            consumedTokens: Number(row.consumed_tokens),
            requestCount: Number(row.request_count),
          },
        ]),
      );
      const fromRow = byModel.get(from);
      if (!fromRow) return;
      const toRow = byModel.get(to);
      if (toRow) {
        // 两个名字今天都有量：合并后删旧行，不能覆盖。
        await conn.query(
          "UPDATE model_daily_usage SET consumed_tokens = ?, request_count = ?, updated_at = ? WHERE usage_date = ? AND model = ?",
          [
            toRow.consumedTokens + fromRow.consumedTokens,
            toRow.requestCount + fromRow.requestCount,
            Date.now(),
            usageDate,
            to,
          ],
        );
        await conn.query(
          "DELETE FROM model_daily_usage WHERE usage_date = ? AND model = ?",
          [usageDate, from],
        );
      } else {
        await conn.query(
          "UPDATE model_daily_usage SET model = ?, updated_at = ? WHERE usage_date = ? AND model = ?",
          [to, Date.now(), usageDate, from],
        );
      }
    };
    if (connection) await rename(connection);
    else await withTransaction(rename);
  },

  /** Keep only the current day; the table is a rolling counter. */
  async deleteBefore(usageDate: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query("DELETE FROM model_daily_usage WHERE usage_date < ?", [
        usageDate,
      ]);
      await conn.query(
        "DELETE FROM model_daily_usage_batches WHERE created_at < ?",
        [Date.parse(`${usageDate}T00:00:00+08:00`)],
      );
    } finally {
      conn.release();
    }
  },
};
