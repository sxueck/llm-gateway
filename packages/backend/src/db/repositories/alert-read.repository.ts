import { getDatabase } from "../connection.js";
import type { ResultSetHeader } from "mysql2/promise";
import { AlertReadRow } from "../types.js";

/** 已读记录保留天数：告警是环境快照，超过该时长的已读 code 不再有意义。 */
const READ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const alertReadRepository = {
  /** 返回该用户当前所有已读告警 code。 */
  async getReadCodes(userId: string): Promise<Set<string>> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT code FROM alert_reads WHERE user_id = ?",
        [userId],
      );
      return new Set((rows as AlertReadRow[]).map(row => row.code));
    } finally {
      conn.release();
    }
  },

  /**
   * 批量标记已读（幂等），并顺手清理过期行——表以单用户几十行计，
   * 借写路径做过期即可，不值得单独的定时任务。返回新写入的 code 数。
   */
  async markRead(userId: string, codes: string[]): Promise<number> {
    const unique = [...new Set(codes)];
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      let inserted = 0;
      if (unique.length > 0) {
        const values = unique.map(code => [userId, code, Date.now()]);
        const [result] = await conn.query(
          "INSERT IGNORE INTO alert_reads (user_id, code, read_at) VALUES ?",
          [values],
        );
        inserted = (result as ResultSetHeader).affectedRows;
      }
      await conn.query("DELETE FROM alert_reads WHERE read_at < ?", [
        Date.now() - READ_RETENTION_MS,
      ]);
      return inserted;
    } finally {
      conn.release();
    }
  },
};
