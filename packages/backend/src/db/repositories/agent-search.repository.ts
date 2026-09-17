import { getDatabase } from "../connection.js";
import {
  AgentSearchRun,
  AgentSearchRunEventRow,
  AgentSearchUsage,
  RepositorySnapshot,
} from "../types.js";

export const repositorySnapshotRepository = {
  async create(
    snapshot: Omit<RepositorySnapshot, "deleted_at">,
  ): Promise<RepositorySnapshot> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO repository_snapshots
         (id, user_id, virtual_key_id, source_type, display_name, git_remote, head_commit,
          manifest_encrypted, dek_encrypted, file_count, total_size, storage_prefix, status,
          created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.user_id,
          snapshot.virtual_key_id,
          snapshot.source_type,
          snapshot.display_name,
          snapshot.git_remote,
          snapshot.head_commit,
          snapshot.manifest_encrypted,
          snapshot.dek_encrypted,
          snapshot.file_count,
          snapshot.total_size,
          snapshot.storage_prefix,
          snapshot.status,
          snapshot.created_at,
          snapshot.expires_at,
        ],
      );
      return { ...snapshot, deleted_at: null };
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<RepositorySnapshot | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM repository_snapshots WHERE id = ?",
        [id],
      );
      const result = rows as any[];
      return result.length === 0
        ? undefined
        : (result[0] as RepositorySnapshot);
    } finally {
      conn.release();
    }
  },

  async markReady(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        "UPDATE repository_snapshots SET status = 'ready' WHERE id = ? AND status = 'uploading'",
        [id],
      );
    } finally {
      conn.release();
    }
  },

  async markDeleted(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        "UPDATE repository_snapshots SET status = ?, deleted_at = ? WHERE id = ?",
        ["deleted", Date.now(), id],
      );
    } finally {
      conn.release();
    }
  },

  async findExpired(now: number, limit = 100): Promise<RepositorySnapshot[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT * FROM repository_snapshots
         WHERE expires_at <= ? AND status != 'deleted' AND deleted_at IS NULL
         LIMIT ?`,
        [now, limit],
      );
      return rows as RepositorySnapshot[];
    } finally {
      conn.release();
    }
  },
};

export const agentSearchRunRepository = {
  async create(
    run: Omit<
      AgentSearchRun,
      | "started_at"
      | "completed_at"
      | "cancellation_requested_at"
      | "result_encrypted"
    >,
  ): Promise<AgentSearchRun> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO agent_search_runs
         (id, user_id, virtual_key_id, plugin_id, plugin_version, plugin_digest, source_type,
          snapshot_id, public_git_url_encrypted, requested_ref, resolved_commit, query_encrypted,
          model_profile, status, error_code, error_message, service_token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, ?)`,
        [
          run.id,
          run.user_id,
          run.virtual_key_id,
          run.plugin_id,
          run.plugin_version,
          run.plugin_digest,
          run.source_type,
          run.snapshot_id,
          run.public_git_url_encrypted,
          run.requested_ref,
          run.resolved_commit,
          run.query_encrypted,
          run.model_profile,
          run.service_token_hash,
          run.created_at,
          run.expires_at,
        ],
      );
      return {
        ...run,
        status: "queued",
        started_at: null,
        completed_at: null,
        cancellation_requested_at: null,
        result_encrypted: null,
      };
    } finally {
      conn.release();
    }
  },

  async getById(id: string): Promise<AgentSearchRun | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM agent_search_runs WHERE id = ?",
        [id],
      );
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as AgentSearchRun);
    } finally {
      conn.release();
    }
  },

  async update(
    id: string,
    updates: Partial<
      Pick<
        AgentSearchRun,
        | "status"
        | "started_at"
        | "completed_at"
        | "result_encrypted"
        | "error_code"
        | "error_message"
      >
    >,
  ): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const fields: string[] = [];
      const values: any[] = [];
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          fields.push(`${key} = ?`);
          values.push(value);
        }
      }
      if (fields.length === 0) return;
      values.push(id);
      await conn.query(
        `UPDATE agent_search_runs SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
    } finally {
      conn.release();
    }
  },

  async requestCancellation(id: string): Promise<boolean> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `UPDATE agent_search_runs
         SET cancellation_requested_at = ?
         WHERE id = ? AND cancellation_requested_at IS NULL
           AND status IN ('queued', 'running')`,
        [Date.now(), id],
      );
      return (result as any).affectedRows > 0;
    } finally {
      conn.release();
    }
  },

  async findByServiceTokenHash(
    tokenHash: string,
  ): Promise<AgentSearchRun | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM agent_search_runs WHERE service_token_hash = ?",
        [tokenHash],
      );
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as AgentSearchRun);
    } finally {
      conn.release();
    }
  },

  async findExpired(now: number, limit = 100): Promise<AgentSearchRun[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT * FROM agent_search_runs
         WHERE expires_at <= ?
           AND status IN ('completed', 'failed', 'cancelled', 'timed_out', 'budget_exceeded')
         LIMIT ?`,
        [now, limit],
      );
      return rows as AgentSearchRun[];
    } finally {
      conn.release();
    }
  },

  async markExpired(id: string): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `UPDATE agent_search_runs
         SET status = 'expired', result_encrypted = NULL, error_code = NULL, error_message = NULL
         WHERE id = ?`,
        [id],
      );
    } finally {
      conn.release();
    }
  },

  async findActiveAtBoot(): Promise<AgentSearchRun[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT * FROM agent_search_runs WHERE status IN ('queued', 'running')`,
      );
      return rows as AgentSearchRun[];
    } finally {
      conn.release();
    }
  },
};

export interface AgentRunMonitoringFilters {
  status?: AgentSearchRun["status"];
  activeOnly?: boolean;
  limit: number;
  offset: number;
}

export interface AgentRunMonitoringItem {
  id: string;
  plugin_id: string;
  plugin_version: string;
  source_type: AgentSearchRun["source_type"];
  model_profile: string;
  status: AgentSearchRun["status"];
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  usage: {
    turn_count: number;
    tool_call_count: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  } | null;
}

export interface AgentRunMonitoringSummary {
  total: number;
  active: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  timed_out: number;
  budget_exceeded: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  avg_duration_ms: number | null;
  snapshot_runs: number;
  snapshots: {
    total: number;
    ready: number;
    file_count: number;
    total_size: number;
  };
}

// 只读取管理端监控所需的非敏感列，绝不返回 query/result/token 或加密字段
export const agentRunMonitoringRepository = {
  async list(filters: AgentRunMonitoringFilters): Promise<{
    items: AgentRunMonitoringItem[];
    summary: AgentRunMonitoringSummary;
  }> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filters.activeOnly) {
        where.push("r.status IN ('queued', 'running')");
      } else if (filters.status) {
        where.push("r.status = ?");
        params.push(filters.status);
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

      const [rows] = await conn.query(
        `SELECT r.id, r.plugin_id, r.plugin_version, r.source_type, r.model_profile,
                r.status, r.created_at, r.started_at, r.completed_at,
                r.error_code, r.error_message,
                u.turn_count, u.tool_call_count, u.input_tokens, u.output_tokens, u.cost
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id${whereSql}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ? OFFSET ?`,
        [...params, filters.limit, filters.offset],
      );
      const items = (rows as any[]).map((row): AgentRunMonitoringItem => {
        const hasUsage = row.turn_count !== null;
        return {
          id: row.id,
          plugin_id: row.plugin_id,
          plugin_version: row.plugin_version,
          source_type: row.source_type,
          model_profile: row.model_profile,
          status: row.status,
          created_at: Number(row.created_at),
          started_at: row.started_at === null ? null : Number(row.started_at),
          completed_at:
            row.completed_at === null ? null : Number(row.completed_at),
          duration_ms:
            row.started_at !== null
              ? Number(row.completed_at ?? Date.now()) - Number(row.started_at)
              : null,
          error_code: row.error_code ?? null,
          error_message: row.error_message ?? null,
          usage: hasUsage
            ? {
                turn_count: Number(row.turn_count),
                tool_call_count: Number(row.tool_call_count),
                input_tokens: Number(row.input_tokens),
                output_tokens: Number(row.output_tokens),
                cost: Number(row.cost),
              }
            : null,
        };
      });

      const [summaryRows] = await conn.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(r.status IN ('queued', 'running')), 0) AS active,
                COALESCE(SUM(r.status = 'queued'), 0) AS queued,
                COALESCE(SUM(r.status = 'running'), 0) AS running,
                COALESCE(SUM(r.status = 'completed'), 0) AS completed,
                COALESCE(SUM(r.status IN ('failed', 'timed_out', 'budget_exceeded', 'cancelled')), 0) AS failed,
                COALESCE(SUM(r.status = 'timed_out'), 0) AS timed_out,
                COALESCE(SUM(r.status = 'budget_exceeded'), 0) AS budget_exceeded,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(u.cost), 0) AS cost,
                AVG(CASE WHEN r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
                         THEN r.completed_at - r.started_at END) AS avg_duration_ms,
                COALESCE(SUM(r.snapshot_id IS NOT NULL), 0) AS snapshot_runs
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id${whereSql}`,
        params,
      );
      const s = (summaryRows as any[])[0] ?? {};

      // 快照是独立资源，数量/体积不受 run 状态筛选影响
      const [snapshotRows] = await conn.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'ready' AND expires_at > ?), 0) AS ready,
                COALESCE(SUM(file_count), 0) AS file_count,
                COALESCE(SUM(total_size), 0) AS total_size
         FROM repository_snapshots
         WHERE deleted_at IS NULL`,
        [Date.now()],
      );
      const snap = (snapshotRows as any[])[0] ?? {};

      const summary: AgentRunMonitoringSummary = {
        total: Number(s.total ?? 0),
        active: Number(s.active ?? 0),
        queued: Number(s.queued ?? 0),
        running: Number(s.running ?? 0),
        completed: Number(s.completed ?? 0),
        failed: Number(s.failed ?? 0),
        timed_out: Number(s.timed_out ?? 0),
        budget_exceeded: Number(s.budget_exceeded ?? 0),
        input_tokens: Number(s.input_tokens ?? 0),
        output_tokens: Number(s.output_tokens ?? 0),
        cost: Number(s.cost ?? 0),
        avg_duration_ms:
          s.avg_duration_ms === null || s.avg_duration_ms === undefined
            ? null
            : Number(s.avg_duration_ms),
        snapshot_runs: Number(s.snapshot_runs ?? 0),
        snapshots: {
          total: Number(snap.total ?? 0),
          ready: Number(snap.ready ?? 0),
          file_count: Number(snap.file_count ?? 0),
          total_size: Number(snap.total_size ?? 0),
        },
      };
      return { items, summary };
    } finally {
      conn.release();
    }
  },
};

export const agentSearchRunEventRepository = {
  async append(
    runId: string,
    seq: number,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO agent_search_run_events (run_id, seq, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [runId, seq, type, JSON.stringify(payload ?? {}), Date.now()],
      );
    } finally {
      conn.release();
    }
  },

  async maxSeq(runId: string): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT MAX(seq) AS max_seq FROM agent_search_run_events WHERE run_id = ?",
        [runId],
      );
      const result = rows as any[];
      return Number(result[0]?.max_seq ?? 0);
    } finally {
      conn.release();
    }
  },

  async listAfter(
    runId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<AgentSearchRunEventRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT * FROM agent_search_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [runId, afterSeq, limit],
      );
      return rows as AgentSearchRunEventRow[];
    } finally {
      conn.release();
    }
  },

  async deleteByRunIds(runIds: string[]): Promise<void> {
    if (runIds.length === 0) return;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `DELETE FROM agent_search_run_events WHERE run_id IN (${runIds.map(() => "?").join(",")})`,
        runIds,
      );
    } finally {
      conn.release();
    }
  },
};

export const agentSearchUsageRepository = {
  async upsert(usage: AgentSearchUsage): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO agent_search_usage
         (run_id, turn_count, tool_call_count, input_tokens, output_tokens, cost, model_route_metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           turn_count = VALUES(turn_count), tool_call_count = VALUES(tool_call_count),
           input_tokens = VALUES(input_tokens), output_tokens = VALUES(output_tokens),
           cost = VALUES(cost), model_route_metadata = VALUES(model_route_metadata),
           updated_at = VALUES(updated_at)`,
        [
          usage.run_id,
          usage.turn_count,
          usage.tool_call_count,
          usage.input_tokens,
          usage.output_tokens,
          usage.cost,
          usage.model_route_metadata,
          usage.updated_at,
        ],
      );
    } finally {
      conn.release();
    }
  },

  async getByRunId(runId: string): Promise<AgentSearchUsage | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT * FROM agent_search_usage WHERE run_id = ?",
        [runId],
      );
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as AgentSearchUsage);
    } finally {
      conn.release();
    }
  },
};
