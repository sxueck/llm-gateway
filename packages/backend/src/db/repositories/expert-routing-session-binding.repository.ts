import { getDatabase } from '../connection.js';
import { EXPERT_ROUTING_ANONYMOUS_SCOPE } from '@llm-gateway/shared';

export interface SessionBindingRow {
  expert_routing_id: string;
  virtual_key_scope: string;
  session_id: string;
  expert_id: string;
  route_source: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
}

export interface SessionBindingKey {
  expertRoutingId: string;
  virtualKeyScope: string;
  sessionId: string;
}

/**
 * Resolve the non-null virtual-key scope for a binding key. Anonymous requests
 * (no virtual key) use the reserved sentinel so MySQL's nullable unique-key
 * semantics cannot produce duplicate anonymous bindings (FR-11).
 */
export function resolveBindingScope(virtualKeyId: string | undefined): string {
  return virtualKeyId && virtualKeyId.trim() ? virtualKeyId : EXPERT_ROUTING_ANONYMOUS_SCOPE;
}

export interface CreateOrSelectResult {
  row: SessionBindingRow;
  /** True when this call's candidate was the first writer (race winner). */
  winner: boolean;
}

export const expertRoutingSessionBindingRepository = {
  /**
   * Read an active binding and atomically apply sliding idle renewal (NFR-4).
   * Returns null when the row is absent or expired. Expired rows are removed
   * inline so a later first-request can re-create with a fresh absolute lifetime.
   */
  async getActiveBinding(
    key: SessionBindingKey,
    idleTtlSeconds: number,
    now: number = Date.now()
  ): Promise<SessionBindingRow | null> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      // Atomic renewal: only rows not yet past either expiry are renewed.
      const [updateResult] = await conn.query(
        `UPDATE expert_routing_session_bindings
         SET last_seen_at = ?,
             idle_expires_at = LEAST(? + ?, absolute_expires_at)
         WHERE expert_routing_id = ?
           AND virtual_key_scope = ?
           AND session_id = ?
           AND absolute_expires_at > ?
           AND idle_expires_at > ?`,
        [now, now, idleTtlSeconds * 1000, key.expertRoutingId, key.virtualKeyScope, key.sessionId, now, now]
      );

      if ((updateResult as any).affectedRows > 0) {
        const [rows] = await conn.query(
          `SELECT * FROM expert_routing_session_bindings
           WHERE expert_routing_id = ? AND virtual_key_scope = ? AND session_id = ?`,
          [key.expertRoutingId, key.virtualKeyScope, key.sessionId]
        );
        const found = (rows as any[])[0];
        return found ? (found as SessionBindingRow) : null;
      }

      // No row renewed: either absent or expired. Drop an expired row if present.
      await conn.query(
        `DELETE FROM expert_routing_session_bindings
         WHERE expert_routing_id = ? AND virtual_key_scope = ? AND session_id = ?
           AND (absolute_expires_at <= ? OR idle_expires_at <= ?)`,
        [key.expertRoutingId, key.virtualKeyScope, key.sessionId, now, now]
      );
      return null;
    } finally {
      conn.release();
    }
  },

  /**
   * First-writer-wins binding creation (NFR-3). Begins a transaction, performs a
   * no-op INSERT ... ON DUPLICATE KEY UPDATE, then a locking SELECT ... FOR
   * UPDATE. The persisted row is authoritative; a losing request must discard
   * its candidate and use the persisted expert.
   */
  async createOrSelectBinding(
    key: SessionBindingKey,
    candidate: { expertId: string; routeSource: string },
    idleTtlSeconds: number,
    absoluteTtlSeconds: number,
    now: number = Date.now()
  ): Promise<CreateOrSelectResult> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const absoluteExpiresAt = now + absoluteTtlSeconds * 1000;
      const idleExpiresAt = Math.min(now + idleTtlSeconds * 1000, absoluteExpiresAt);

      const [insertResult] = await conn.query(
        `INSERT INTO expert_routing_session_bindings
           (expert_routing_id, virtual_key_scope, session_id, expert_id, route_source,
            created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE expert_id = expert_id`,
        [
          key.expertRoutingId,
          key.virtualKeyScope,
          key.sessionId,
          candidate.expertId,
          candidate.routeSource,
          now,
          now,
          idleExpiresAt,
          absoluteExpiresAt,
        ]
      );

      const [rows] = await conn.query(
        `SELECT * FROM expert_routing_session_bindings
         WHERE expert_routing_id = ? AND virtual_key_scope = ? AND session_id = ?
         FOR UPDATE`,
        [key.expertRoutingId, key.virtualKeyScope, key.sessionId]
      );

      await conn.commit();

      const row = (rows as any[])[0] as SessionBindingRow;
      // affectedRows === 1 => fresh insert (winner); 0 => existing row, no-op (loser).
      const winner = (insertResult as any).affectedRows === 1;
      return { row, winner };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  },

  async deleteBinding(key: SessionBindingKey): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `DELETE FROM expert_routing_session_bindings
         WHERE expert_routing_id = ? AND virtual_key_scope = ? AND session_id = ?`,
        [key.expertRoutingId, key.virtualKeyScope, key.sessionId]
      );
    } finally {
      conn.release();
    }
  },

  /** Invalidate all bindings pointing at a specific (now removed/changed) expert. */
  async deleteByExpert(expertRoutingId: string, expertId: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `DELETE FROM expert_routing_session_bindings
         WHERE expert_routing_id = ? AND expert_id = ?`,
        [expertRoutingId, expertId]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  /** Invalidate all bindings for a config (used when the config is deleted). */
  async deleteByConfig(expertRoutingId: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `DELETE FROM expert_routing_session_bindings WHERE expert_routing_id = ?`,
        [expertRoutingId]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  /**
   * Bounded batch cleanup of expired rows (NFR-4). Uses the idle-expiry index
   * and continues in later runs rather than issuing an unbounded delete.
   * Returns the number of rows deleted so callers can log/schedule.
   */
  async cleanupExpired(now: number = Date.now(), batchSize: number = 500): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      // A row is expired when now >= idle_expires_at OR now >= absolute_expires_at.
      // The idle index covers the common early-expiry path; absolute covers the rest.
      const [result] = await conn.query(
        `DELETE FROM expert_routing_session_bindings
         WHERE idle_expires_at <= ? OR absolute_expires_at <= ?
         LIMIT ?`,
        [now, now, batchSize]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },
};
