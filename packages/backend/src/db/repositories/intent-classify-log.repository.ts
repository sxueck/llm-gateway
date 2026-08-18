import { getDatabase } from "../connection.js";

export const intentClassifyLogRepository = {
  async create(log: {
    id: string;
    virtual_key_id: string | null;
    classifier_model: string;
    top_label: string | null;
    latency_ms: number;
    seq_len: number;
    input_truncated: boolean;
  }) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO intent_classify_logs (
          id, virtual_key_id, classifier_model, top_label,
          latency_ms, seq_len, input_truncated, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.virtual_key_id || null,
          log.classifier_model,
          log.top_label || null,
          log.latency_ms,
          log.seq_len || 0,
          log.input_truncated ? 1 : 0,
          Date.now(),
        ],
      );
    } finally {
      conn.release();
    }
  },

  async getGlobalStatistics(startTime: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
          COUNT(*) as total_requests,
          AVG(latency_ms) as avg_latency_ms
        FROM intent_classify_logs
        WHERE created_at >= ?`,
        [startTime],
      );
      const result = rows as any[];
      if (result.length === 0) {
        return {
          totalRequests: 0,
          avgClassificationTime: 0,
        };
      }
      return {
        totalRequests: result[0].total_requests || 0,
        avgClassificationTime: Math.round(result[0].avg_latency_ms || 0),
      };
    } finally {
      conn.release();
    }
  },
};
