import { getDatabase } from '../connection.js';

export interface BlockedIpRow {
  ip: string;
  reason: string | null;
  created_at: number;
  created_by: string | null;
}

export const blockedIpRepository = {
  async getAll(): Promise<BlockedIpRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ip, reason, created_at, created_by
         FROM blocked_ips
         ORDER BY created_at DESC`
      );
      return rows as BlockedIpRow[];
    } finally {
      conn.release();
    }
  },

  async get(ip: string): Promise<BlockedIpRow | null> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ip, reason, created_at, created_by
         FROM blocked_ips
         WHERE ip = ?
         LIMIT 1`,
        [ip]
      );
      const result = rows as BlockedIpRow[];
      if (!result.length) return null;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async upsert(record: { ip: string; reason?: string | null; createdAt?: number; createdBy?: string | null }): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO blocked_ips (ip, reason, created_at, created_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           reason = VALUES(reason),
           created_at = VALUES(created_at),
           created_by = VALUES(created_by)`,
        [
          record.ip,
          record.reason || null,
          record.createdAt ?? Date.now(),
          record.createdBy || null,
        ]
      );
    } finally {
      conn.release();
    }
  },

  async remove(ip: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(`DELETE FROM blocked_ips WHERE ip = ?`, [ip]);
    } finally {
      conn.release();
    }
  },
};
