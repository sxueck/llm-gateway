import { getDatabase } from '../connection.js';

export interface TrainingRecordFilter {
  status?: 'pending_review' | 'accepted' | 'rejected';
  limit?: number;
}

/**
 * §5.9 misclassification feedback loop. The historical judge-flow columns are
 * repurposed: judge_* fields carry the original routing decision, final_*
 * fields carry the operator's correction. `input_hash` (from the routing log's
 * request_hash) dedupes repeated feedback for the same prompt.
 */
export const expertRoutingTrainingRecordRepository = {
  /**
   * Upsert a feedback record: same (config, input_hash) bumps occurrence_count
   * and refreshes the correction instead of accumulating duplicates.
   */
  async upsertFeedback(record: {
    id: string;
    expert_routing_id: string;
    input_hash: string;
    input_text: string;
    judge_intent_label: string;
    judge_confidence: number;
    final_intent_label: string;
    final_expert_id: string | null;
  }): Promise<void> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    const now = Date.now();
    try {
      await conn.query(
        `INSERT INTO expert_routing_training_records (
          id, expert_routing_id, input_hash, input_text,
          judge_prompt_version, judge_intent_label, judge_confidence,
          final_intent_label, final_expert_id,
          status, occurrence_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'v2-feedback', ?, ?, ?, ?, 'pending_review', 1, ?, ?)
        ON DUPLICATE KEY UPDATE
          final_intent_label = VALUES(final_intent_label),
          final_expert_id = VALUES(final_expert_id),
          judge_intent_label = VALUES(judge_intent_label),
          judge_confidence = VALUES(judge_confidence),
          occurrence_count = occurrence_count + 1,
          updated_at = VALUES(updated_at)`,
        [
          record.id,
          record.expert_routing_id,
          record.input_hash,
          record.input_text,
          record.judge_intent_label,
          record.judge_confidence,
          record.final_intent_label,
          record.final_expert_id,
          now,
          now,
        ]
      );
    } finally {
      conn.release();
    }
  },

  /** Replay export: operator-corrected records, newest first. */
  async listByConfig(configId: string, filter: TrainingRecordFilter = {}) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const conditions = ['expert_routing_id = ?'];
      const params: any[] = [configId];
      if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 200;
      const [rows] = await conn.query(
        `SELECT id, input_hash, input_text, judge_intent_label, judge_confidence,
          final_intent_label, final_expert_id, status, occurrence_count,
          created_at, updated_at
         FROM expert_routing_training_records
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ?`,
        [...params, limit]
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },
};
