import { randomUUID } from 'node:crypto';
import { getDatabase } from '../connection.js';
import { EXPERT_ROUTING_ANONYMOUS_SCOPE } from '@llm-gateway/shared';

export interface ContextBindingRow {
  virtual_key_scope: string;
  session_id: string;
  fingerprint: string;
  protocol: string;
  context_version: number;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
}

export interface ContextBindingKey {
  virtualKeyScope: string;
  sessionId: string;
}

/**
 * Resolve the non-null scope for a binding key. Mirrors the expert-routing
 * pattern: anonymous requests use the reserved sentinel so nullable unique-key
 * semantics cannot produce duplicate anonymous bindings.
 */
export function resolveContextBindingScope(virtualKeyId: string | undefined | null): string {
  return virtualKeyId && virtualKeyId.trim() ? virtualKeyId : EXPERT_ROUTING_ANONYMOUS_SCOPE;
}

export interface ContextSwitchEventInput {
  virtualKeyId: string | null;
  sessionId: string;
  protocol: string;
  sourceFingerprint: string | null;
  targetFingerprint: string;
  sourceContextVersion: number | null;
  targetContextVersion: number;
  strategy: string;
  cleanedBlocks: number;
  cleanedChars: number;
  reason?: string | null;
}

export const contextNormalizationRepository = {
  /**
   * Read an active binding and atomically apply sliding idle renewal.
   * Returns null when absent or expired; expired rows are removed inline so a
   * later first-request can re-create with a fresh absolute lifetime.
   */
  async getActiveBinding(
    key: ContextBindingKey,
    idleTtlSeconds: number,
    now: number = Date.now()
  ): Promise<ContextBindingRow | null> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [updateResult] = await conn.query(
        `UPDATE session_context_bindings
         SET last_seen_at = ?,
             idle_expires_at = LEAST(? + ?, absolute_expires_at)
         WHERE virtual_key_scope = ?
           AND session_id = ?
           AND absolute_expires_at > ?
           AND idle_expires_at > ?`,
        [now, now, idleTtlSeconds * 1000, key.virtualKeyScope, key.sessionId, now, now]
      );

      if ((updateResult as any).affectedRows > 0) {
        const [rows] = await conn.query(
          `SELECT * FROM session_context_bindings
           WHERE virtual_key_scope = ? AND session_id = ?`,
          [key.virtualKeyScope, key.sessionId]
        );
        const found = (rows as any[])[0];
        return found ? (found as ContextBindingRow) : null;
      }

      await conn.query(
        `DELETE FROM session_context_bindings
         WHERE virtual_key_scope = ? AND session_id = ?
           AND (absolute_expires_at <= ? OR idle_expires_at <= ?)`,
        [key.virtualKeyScope, key.sessionId, now, now]
      );
      return null;
    } finally {
      conn.release();
    }
  },

  /**
    * Record a first-request binding. INSERT ... ON DUPLICATE KEY UPDATE does not
    * overwrite fingerprint (first-writer-wins). Callers MUST compare the returned
    * row's fingerprint and treat a mismatch as a switch.
   */
  async createBinding(
    key: ContextBindingKey,
    fingerprint: string,
    protocol: string,
    idleTtlSeconds: number,
    absoluteTtlSeconds: number,
    now: number = Date.now()
  ): Promise<ContextBindingRow> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const absoluteExpiresAt = now + absoluteTtlSeconds * 1000;
      const idleExpiresAt = Math.min(now + idleTtlSeconds * 1000, absoluteExpiresAt);

      await conn.query(
        `INSERT INTO session_context_bindings
           (virtual_key_scope, session_id, fingerprint, protocol, context_version,
            created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           last_seen_at = VALUES(last_seen_at),
           idle_expires_at = LEAST(VALUES(idle_expires_at), absolute_expires_at)`,
        [key.virtualKeyScope, key.sessionId, fingerprint, protocol, now, now, idleExpiresAt, absoluteExpiresAt]
      );

      const [rows] = await conn.query(
        `SELECT * FROM session_context_bindings
         WHERE virtual_key_scope = ? AND session_id = ?`,
        [key.virtualKeyScope, key.sessionId]
      );
      return (rows as any[])[0] as ContextBindingRow;
    } finally {
      conn.release();
    }
  },

  /**
   * Apply a model switch: update fingerprint, bump context_version, and slide
   * idle expiry. Absolute lifetime stays fixed at creation (NFR-3).
   */
  async updateBindingOnSwitch(
    key: ContextBindingKey,
    fingerprint: string,
    protocol: string,
    idleTtlSeconds: number,
    now: number = Date.now()
  ): Promise<ContextBindingRow | null> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `UPDATE session_context_bindings
         SET fingerprint = ?,
             protocol = ?,
             context_version = context_version + 1,
             last_seen_at = ?,
             idle_expires_at = LEAST(? + ?, absolute_expires_at)
         WHERE virtual_key_scope = ? AND session_id = ?`,
        [fingerprint, protocol, now, now, idleTtlSeconds * 1000, key.virtualKeyScope, key.sessionId]
      );

      const [rows] = await conn.query(
        `SELECT * FROM session_context_bindings
         WHERE virtual_key_scope = ? AND session_id = ?`,
        [key.virtualKeyScope, key.sessionId]
      );
      const found = (rows as any[])[0];
      return found ? (found as ContextBindingRow) : null;
    } finally {
      conn.release();
    }
  },

  async insertSwitchEvent(event: ContextSwitchEventInput, now: number = Date.now()): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO context_switch_events
           (id, virtual_key_id, session_id, protocol, source_fingerprint, target_fingerprint,
            source_context_version, target_context_version, strategy, cleaned_blocks,
            cleaned_chars, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          event.virtualKeyId,
          event.sessionId,
          event.protocol,
          event.sourceFingerprint,
          event.targetFingerprint,
          event.sourceContextVersion,
          event.targetContextVersion,
          event.strategy,
          event.cleanedBlocks,
          event.cleanedChars,
          event.reason ?? null,
          now,
        ]
      );
    } finally {
      conn.release();
    }
  },

  /** Bounded batch cleanup of expired bindings (NFR-3). */
  async cleanupExpiredBindings(now: number = Date.now(), batchSize: number = 500): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `DELETE FROM session_context_bindings
         WHERE idle_expires_at <= ? OR absolute_expires_at <= ?
         LIMIT ?`,
        [now, now, batchSize]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  async deleteBindingsByScope(virtualKeyScope: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `DELETE FROM session_context_bindings WHERE virtual_key_scope = ?`,
        [virtualKeyScope]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  async cleanupOldSwitchEvents(
    now: number = Date.now(),
    retentionMs: number = 30 * 24 * 3600 * 1000,
    batchSize: number = 500
  ): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `DELETE FROM context_switch_events
         WHERE created_at <= ?
         LIMIT ?`,
        [now - retentionMs, batchSize]
      );
      return (result as any).affectedRows || 0;
    } finally {
      conn.release();
    }
  },
};
