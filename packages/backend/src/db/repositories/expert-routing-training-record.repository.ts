import { getDatabase } from '../connection.js';

export type TrainingRecordStatus = 'pending_review' | 'accepted' | 'rejected';

export const expertRoutingTrainingRecordRepository = {
  async createOrIncrement(record: {
    id: string;
    expert_routing_id: string;
    input_hash: string;
    input_text: string;
    local_result?: string;
    classifier_revision?: string;
    judge_prompt_version: string;
    judge_model?: string;
    judge_intent_label: string;
    judge_confidence: number;
    judge_reason?: string;
    final_intent_label: string;
    final_expert_id?: string;
    status: TrainingRecordStatus;
  }) {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO expert_routing_training_records (
          id, expert_routing_id, input_hash, input_text, local_result,
          classifier_revision, judge_prompt_version, judge_model,
          judge_intent_label, judge_confidence, judge_reason,
          final_intent_label, final_expert_id, status, occurrence_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON DUPLICATE KEY UPDATE
          occurrence_count = occurrence_count + 1,
          status = IF(
            judge_prompt_version <> VALUES(judge_prompt_version)
            OR judge_intent_label <> VALUES(judge_intent_label),
            'pending_review',
            status
          ),
          final_intent_label = IF(
            judge_prompt_version <> VALUES(judge_prompt_version)
            OR judge_intent_label <> VALUES(judge_intent_label),
            VALUES(final_intent_label),
            final_intent_label
          ),
          final_expert_id = IF(
            judge_prompt_version <> VALUES(judge_prompt_version)
            OR judge_intent_label <> VALUES(judge_intent_label),
            VALUES(final_expert_id),
            final_expert_id
          ),
          reviewed_at = IF(
            judge_prompt_version <> VALUES(judge_prompt_version)
            OR judge_intent_label <> VALUES(judge_intent_label),
            NULL,
            reviewed_at
          ),
          local_result = VALUES(local_result),
          classifier_revision = VALUES(classifier_revision),
          judge_prompt_version = VALUES(judge_prompt_version),
          judge_model = VALUES(judge_model),
          judge_intent_label = VALUES(judge_intent_label),
          judge_confidence = VALUES(judge_confidence),
          judge_reason = VALUES(judge_reason),
          updated_at = VALUES(updated_at)`,
        [
          record.id,
          record.expert_routing_id,
          record.input_hash,
          record.input_text,
          record.local_result || null,
          record.classifier_revision || null,
          record.judge_prompt_version,
          record.judge_model || null,
          record.judge_intent_label,
          record.judge_confidence,
          record.judge_reason || null,
          record.final_intent_label,
          record.final_expert_id || null,
          record.status,
          now,
          now,
        ]
      );
    } finally {
      conn.release();
    }
  },

  async getByConfigId(configId: string, status?: TrainingRecordStatus, limit?: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const where = status ? 'WHERE expert_routing_id = ? AND status = ?' : 'WHERE expert_routing_id = ?';
      const params: Array<string | number> = status ? [configId, status] : [configId];
      if (limit !== undefined) params.push(limit);
      const [rows] = await conn.query(
        `SELECT * FROM expert_routing_training_records ${where} ORDER BY updated_at DESC${limit === undefined ? '' : ' LIMIT ?'}`,
        params
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },

  async updateReview(configId: string, id: string, status: TrainingRecordStatus, finalIntentLabel: string) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `UPDATE expert_routing_training_records
         SET status = ?, final_intent_label = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND expert_routing_id = ?`,
        [status, finalIntentLabel, Date.now(), Date.now(), id, configId]
      );
      return Number((result as any).affectedRows || 0);
    } finally {
      conn.release();
    }
  },
};
