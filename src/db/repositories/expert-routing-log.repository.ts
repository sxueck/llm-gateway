import { getDatabase } from '../connection.js';

export const expertRoutingLogRepository = {
  async create(log: {
    id: string;
    virtual_key_id: string | null;
    expert_routing_id: string;
    request_hash: string;
    classifier_model: string;
    classification_result: string;
    selected_expert_id: string;
    selected_expert_type: string;
    selected_expert_name: string;
    classification_time: number;
    original_request?: string;
    classifier_request?: string;
    classifier_response?: string;
  }) {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        `INSERT INTO expert_routing_logs (
          id, virtual_key_id, expert_routing_id, request_hash,
          classifier_model, classification_result, selected_expert_id,
          selected_expert_type, selected_expert_name, classification_time,
          original_request, classifier_request, classifier_response, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.virtual_key_id || null,
          log.expert_routing_id,
          log.request_hash,
          log.classifier_model,
          log.classification_result,
          log.selected_expert_id,
          log.selected_expert_type,
          log.selected_expert_name,
          log.classification_time,
          log.original_request || null,
          log.classifier_request || null,
          log.classifier_response || null,
          now,
        ]
      );
    } finally {
      conn.release();
    }
  },

  async getByConfigId(configId: string, limit: number = 100) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM expert_routing_logs WHERE expert_routing_id = ? ORDER BY created_at DESC LIMIT ?',
        [configId, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getStatistics(configId: string, timeRange?: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      let query = `
        SELECT
          classification_result,
          COUNT(*) as count,
          AVG(classification_time) as avg_time
        FROM expert_routing_logs
        WHERE expert_routing_id = ?
      `;
      const params: any[] = [configId];

      if (timeRange) {
        const cutoffTime = Date.now() - timeRange;
        query += ' AND created_at >= ?';
        params.push(cutoffTime);
      }

      query += ' GROUP BY classification_result';

      const [rows] = await conn.query(query, params);
      return rows;
    } finally {
      conn.release();
    }
  },

  async getByCategory(configId: string, category: string, limit: number = 100) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT * FROM expert_routing_logs WHERE expert_routing_id = ? AND classification_result = ? ORDER BY created_at DESC LIMIT ?',
        [configId, category, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM expert_routing_logs WHERE id = ?', [id]);
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
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
          AVG(classification_time) as avg_classification_time
        FROM expert_routing_logs
        WHERE created_at >= ?`,
        [startTime]
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
        avgClassificationTime: Math.round(result[0].avg_classification_time || 0),
      };
    } finally {
      conn.release();
    }
  },
};
