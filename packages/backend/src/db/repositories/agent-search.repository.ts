import { getDatabase } from '../connection.js';
import { AgentSearchRun, AgentSearchRunEventRow, AgentSearchUsage, RepositorySnapshot } from '../types.js';

export const repositorySnapshotRepository = {
  async create(snapshot: Omit<RepositorySnapshot, 'deleted_at'>): Promise<RepositorySnapshot> {
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
      const [rows] = await conn.query('SELECT * FROM repository_snapshots WHERE id = ?', [id]);
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as RepositorySnapshot);
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
        'UPDATE repository_snapshots SET status = ?, deleted_at = ? WHERE id = ?',
        ['deleted', Date.now(), id],
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
  async create(run: Omit<
    AgentSearchRun,
    'started_at' | 'completed_at' | 'cancellation_requested_at' | 'result_encrypted'
  >): Promise<AgentSearchRun> {
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
        status: 'queued',
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
      const [rows] = await conn.query('SELECT * FROM agent_search_runs WHERE id = ?', [id]);
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as AgentSearchRun);
    } finally {
      conn.release();
    }
  },

  async update(
    id: string,
    updates: Partial<Pick<AgentSearchRun,
      'status' | 'started_at' | 'completed_at' | 'result_encrypted' | 'error_code' | 'error_message'
    >>,
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
      await conn.query(`UPDATE agent_search_runs SET ${fields.join(', ')} WHERE id = ?`, values);
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

  async findByServiceTokenHash(tokenHash: string): Promise<AgentSearchRun | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM agent_search_runs WHERE service_token_hash = ?',
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
        'SELECT MAX(seq) AS max_seq FROM agent_search_run_events WHERE run_id = ?',
        [runId],
      );
      const result = rows as any[];
      return Number(result[0]?.max_seq ?? 0);
    } finally {
      conn.release();
    }
  },

  async listAfter(runId: string, afterSeq: number, limit = 500): Promise<AgentSearchRunEventRow[]> {
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
        `DELETE FROM agent_search_run_events WHERE run_id IN (${runIds.map(() => '?').join(',')})`,
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
      const [rows] = await conn.query('SELECT * FROM agent_search_usage WHERE run_id = ?', [runId]);
      const result = rows as any[];
      return result.length === 0 ? undefined : (result[0] as AgentSearchUsage);
    } finally {
      conn.release();
    }
  },
};
