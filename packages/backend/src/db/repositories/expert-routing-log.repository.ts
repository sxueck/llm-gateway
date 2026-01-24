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
    route_source?: string;
    prompt_tokens?: number;
    cleaned_content_length?: number;
    semantic_score?: number | null;
  }) {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      // Backward compatible insert:
      // some deployments may not have v22 migration applied yet.
      try {
        await conn.query(
          `INSERT INTO expert_routing_logs (
            id, virtual_key_id, expert_routing_id, request_hash,
            classifier_model, classification_result, selected_expert_id,
            selected_expert_type, selected_expert_name, classification_time,
            original_request, classifier_request, classifier_response, created_at,
            route_source, prompt_tokens, cleaned_content_length, semantic_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            log.route_source || null,
            log.prompt_tokens || 0,
            log.cleaned_content_length || 0,
            log.semantic_score || null,
          ]
        );
      } catch (e: any) {
        // MySQL: ER_BAD_FIELD_ERROR; SQLite: SQLITE_ERROR (when using sqlite driver)
        // We only fallback on schema mismatch errors.
        const message = String(e?.message || '');
        const code = String(e?.code || '');
        const isMissingColumn =
          code === 'ER_BAD_FIELD_ERROR' ||
          /Unknown column\s+'(route_source|prompt_tokens|cleaned_content_length|semantic_score)'/i.test(message) ||
          /no such column:\s*(route_source|prompt_tokens|cleaned_content_length|semantic_score)/i.test(message);

        if (!isMissingColumn) throw e;

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
      }
    } finally {
      conn.release();
    }
  },

  async getRouteStats(configId: string, timeRange?: number) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      let query = `
        SELECT
          route_source,
          COUNT(*) as count,
          AVG(prompt_tokens) as avg_prompt_tokens,
          AVG(cleaned_content_length) as avg_cleaned_length
        FROM expert_routing_logs
        WHERE expert_routing_id = ?
      `;

      const params: any[] = [configId];
      if (timeRange) {
        const cutoffTime = Date.now() - timeRange;
        query += ' AND created_at >= ?';
        params.push(cutoffTime);
      }

      query += ' GROUP BY route_source';

      try {
        const [rows] = await conn.query(query, params);
        return rows;
      } catch (e: any) {
        // If the deployment hasn't applied the migration adding these columns,
        // we should not fail the whole statistics endpoint.
        const message = String(e?.message || '');
        const code = String(e?.code || '');
        const isMissingColumn =
          code === 'ER_BAD_FIELD_ERROR' ||
          /Unknown column\s+'(route_source|prompt_tokens|cleaned_content_length)'/i.test(message) ||
          /no such column:\s*(route_source|prompt_tokens|cleaned_content_length)/i.test(message);
        if (!isMissingColumn) throw e;
        return [];
      }
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
