import { getDatabase } from "../connection.js";
import { UserPluginEnrollmentRow, WorkerPluginRow } from "../types.js";

export const workerPluginRepository = {
  async create(
    plugin: Omit<
      WorkerPluginRow,
      "deprecated_at" | "revoked_at" | "bundle_url" | "signature"
    > & { bundle_url?: string | null; signature?: string | null },
  ): Promise<WorkerPluginRow> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO worker_plugins
         (id, version, digest, name, description, manifest_json, bundle_files_json, changelog,
          bundle_url, signature, status, published_at, deprecated_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [
          plugin.id,
          plugin.version,
          plugin.digest,
          plugin.name,
          plugin.description,
          plugin.manifest_json,
          plugin.bundle_files_json,
          plugin.changelog,
          plugin.bundle_url ?? null,
          plugin.signature ?? null,
          plugin.status,
          plugin.published_at,
          plugin.created_at,
        ],
      );
      return {
        ...plugin,
        bundle_url: plugin.bundle_url ?? null,
        signature: plugin.signature ?? null,
        deprecated_at: null,
        revoked_at: null,
      } as WorkerPluginRow;
    } finally {
      conn.release();
    }
  },

  async getByIdVersion(
    id: string,
    version: string,
  ): Promise<WorkerPluginRow | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM worker_plugins WHERE id = ? AND version = ?",
        [id, version],
      );
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as WorkerPluginRow);
    } finally {
      conn.release();
    }
  },

  async listAll(): Promise<WorkerPluginRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM worker_plugins ORDER BY id ASC, created_at DESC",
      );
      return rows as WorkerPluginRow[];
    } finally {
      conn.release();
    }
  },

  async setStatus(
    id: string,
    version: string,
    status: WorkerPluginRow["status"],
  ): Promise<WorkerPluginRow | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const now = Date.now();
      const timestampColumn =
        status === "published"
          ? "published_at"
          : status === "deprecated"
            ? "deprecated_at"
            : status === "revoked"
              ? "revoked_at"
              : null;
      const sets = ["status = ?", "deprecated_at = NULL", "revoked_at = NULL"];
      const values: unknown[] = [status];
      if (timestampColumn) {
        sets.push(`${timestampColumn} = ?`);
        values.push(now);
      }
      values.push(id, version);
      await conn.query(
        `UPDATE worker_plugins SET ${sets.join(", ")} WHERE id = ? AND version = ?`,
        values,
      );
      return this.getByIdVersion(id, version);
    } finally {
      conn.release();
    }
  },
};

export const userPluginEnrollmentRepository = {
  async upsert(
    enrollment: Omit<UserPluginEnrollmentRow, "updated_at">,
  ): Promise<UserPluginEnrollmentRow> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const now = Date.now();
      await conn.query(
        `INSERT INTO user_plugin_enrollments (user_id, plugin_id, version, enabled, is_default, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           version = VALUES(version), enabled = VALUES(enabled),
           is_default = VALUES(is_default), updated_at = VALUES(updated_at)`,
        [
          enrollment.user_id,
          enrollment.plugin_id,
          enrollment.version,
          enrollment.enabled,
          enrollment.is_default,
          now,
        ],
      );
      return { ...enrollment, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async listByUser(userId: string): Promise<UserPluginEnrollmentRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM user_plugin_enrollments WHERE user_id = ? ORDER BY plugin_id ASC",
        [userId],
      );
      return rows as UserPluginEnrollmentRow[];
    } finally {
      conn.release();
    }
  },

  async clearDefault(
    userId: string,
    pluginId: string,
    exceptVersion: string,
  ): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `UPDATE user_plugin_enrollments
         SET is_default = 0, updated_at = ?
         WHERE user_id = ? AND plugin_id = ? AND version != ? AND is_default = 1`,
        [Date.now(), userId, pluginId, exceptVersion],
      );
    } finally {
      conn.release();
    }
  },
};
