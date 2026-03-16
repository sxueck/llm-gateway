import { getDatabase } from '../connection.js';
import { ApiRequestBuffer } from '../types.js';
import { addToBuffer, shouldFlush, flushApiRequestBuffer } from '../utils/buffer.js';
import { generateTimeBuckets, initializeTimeBuckets } from '../utils/time-buckets.js';
import { debugModeService } from '../../services/debug-mode.js';

function getDisableLoggingCondition(): string {
  return '(ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)';
}

export const apiRequestRepository = {
  async create(request: ApiRequestBuffer): Promise<void> {
    // When developer debug mode is active, skip persisting request logs to database.
    if (debugModeService.isActive()) {
      return;
    }

    addToBuffer(request);
 
    if (shouldFlush()) {
      await flushApiRequestBuffer();
    }
  },

  async getLastRequestByIp(ip: string) {
    if (!ip) return null;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT ar.created_at, ar.user_agent
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.ip = ? AND ${loggingCondition}
         ORDER BY ar.created_at DESC
         LIMIT 1`,
        [ip]
      );
      const result = rows as any[];
      if (result.length === 0) return null;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async getLastRequest() {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ip, created_at, user_agent FROM api_requests ORDER BY created_at DESC LIMIT 1`
      );
      const result = rows as any[];
      if (result.length === 0) return null;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async getRecentUniqueIps(limit: number = 30) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const loggingCondition = getDisableLoggingCondition();
      
      const [rows] = await conn.query(
        `SELECT
          ar.ip,
          MAX(ar.created_at) as last_seen,
          COUNT(*) as count
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.created_at > ? AND ${loggingCondition}
         GROUP BY ar.ip
         ORDER BY last_seen DESC
         LIMIT ?`,
        [cutoff, limit]
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },

  async getStats(options?: { startTime?: number; endTime?: number }) {
    const now = Date.now();
    const startTime = options?.startTime ?? (now - 24 * 60 * 60 * 1000);
    const endTime = options?.endTime || now;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as successful_requests,
          SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as failed_requests,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.total_tokens ELSE 0 END) as total_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.prompt_tokens ELSE 0 END) as prompt_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN ar.completion_tokens ELSE 0 END) as completion_tokens,
          SUM(ar.cached_tokens) as cached_tokens,
          AVG(ar.response_time) as avg_response_time,
          SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
          SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) as prompt_cache_hits,
          0 as cache_saved_tokens
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ${loggingCondition}`,
        [startTime, endTime]
      );

      const result = rows as any[];
      if (result.length === 0) {
        return {
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          avgResponseTime: 0,
          cacheHits: 0,
          promptCacheHits: 0,
          cacheSavedTokens: 0,
        };
      }

      const row = result[0];
      return {
        totalRequests: row.total_requests || 0,
        successfulRequests: row.successful_requests || 0,
        failedRequests: row.failed_requests || 0,
        totalTokens: row.total_tokens || 0,
        promptTokens: row.prompt_tokens || 0,
        completionTokens: row.completion_tokens || 0,
        cachedTokens: row.cached_tokens || 0,
        avgResponseTime: row.avg_response_time || 0,
        cacheHits: row.cache_hits || 0,
        promptCacheHits: row.prompt_cache_hits || 0,
        cacheSavedTokens: row.cache_saved_tokens || 0,
      };
    } finally {
      conn.release();
    }
  },

  async getByVirtualKey(virtualKeyId: string, limit: number = 100) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ar.*
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.virtual_key_id = ? AND ${getDisableLoggingCondition()}
         ORDER BY ar.created_at DESC
         LIMIT ?`,
        [virtualKeyId, limit]
      );
      return rows;
    } finally {
      conn.release();
    }
  },

  async getTrend(options?: { startTime?: number; endTime?: number; interval?: 'hour' | 'day' }) {
    const now = Date.now();
    const startTime = options?.startTime ?? (now - 24 * 60 * 60 * 1000);
    const endTime = options?.endTime || now;
    const interval = options?.interval || 'hour';

    const intervalMs = interval === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          FLOOR(ar.created_at / ?) * ? as time_bucket,
          ar.virtual_key_id,
          vk.name as virtual_key_name,
          COUNT(*) as count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as error_count,
          SUM(ar.total_tokens) as total_tokens
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ${loggingCondition}
        GROUP BY time_bucket, ar.virtual_key_id, vk.name
        HAVING time_bucket IS NOT NULL
        ORDER BY time_bucket ASC, ar.virtual_key_id ASC`,
        [intervalMs, intervalMs, startTime, endTime]
      );

      const result = rows as any[];

      if (!result || result.length === 0) {
        return [];
      }

      const virtualKeyMap = new Map<string, { id: string; name: string }>();
      const dataByKey = new Map<string, Map<number, any>>();

      const timePoints = generateTimeBuckets(startTime, endTime, intervalMs);

      result.forEach(row => {
        const keyId = row.virtual_key_id || 'unknown';
        const keyName = row.virtual_key_name || '未知密钥';

        if (!virtualKeyMap.has(keyId)) {
          virtualKeyMap.set(keyId, { id: keyId, name: keyName });
        }

        if (!dataByKey.has(keyId)) {
          dataByKey.set(keyId, initializeTimeBuckets(timePoints));
        }

        const bucket = Number(row.time_bucket);
        if (!bucket || isNaN(bucket)) {
          return;
        }

        const keyBuckets = dataByKey.get(keyId)!;
        if (keyBuckets.has(bucket)) {
          keyBuckets.set(bucket, {
            timestamp: bucket,
            requestCount: Number(row.count) || 0,
            successCount: Number(row.success_count) || 0,
            errorCount: Number(row.error_count) || 0,
            tokenCount: Number(row.total_tokens) || 0
          });
        }
      });

      const trendByKey = Array.from(dataByKey.entries()).map(([keyId, buckets]) => ({
        virtualKeyId: keyId,
        virtualKeyName: virtualKeyMap.get(keyId)?.name || '未知密钥',
        data: Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp)
      }));

      return trendByKey;
    } finally {
      conn.release();
    }
  },

  async getAll(options?: {
    limit?: number;
    offset?: number;
    virtualKeyId?: string;
    providerId?: string;
    model?: string;
    startTime?: number;
    endTime?: number;
    status?: string;
  }) {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      let countQuery = `
        SELECT COUNT(*) as total
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ${loggingCondition}
      `;
      let dataQuery = `
        SELECT
          ar.id,
          ar.virtual_key_id,
          ar.provider_id,
          ar.model,
          ar.prompt_tokens,
          ar.completion_tokens,
          ar.total_tokens,
          ar.cached_tokens,
          ar.status,
          ar.response_time,
          ar.tffb_ms,
          ar.error_message,
          ar.request_params_json,
          ar.response_meta_json,
          LEFT(COALESCE(ap.request_body, ar.request_body), 2000) AS request_body,
          LEFT(COALESCE(ap.response_body, ar.response_body), 2000) AS response_body,
          ar.cache_hit,
          ar.request_type,
          ar.compression_original_tokens,
          ar.compression_saved_tokens,
          ar.ip,
          ar.user_agent,
          ar.created_at
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        LEFT JOIN api_request_payloads ap ON ap.request_id = ar.id
        WHERE ${loggingCondition}
      `;
      const params: any[] = [];

      if (options?.virtualKeyId) {
        countQuery += ' AND ar.virtual_key_id = ?';
        dataQuery += ' AND ar.virtual_key_id = ?';
        params.push(options.virtualKeyId);
      }

      if (options?.providerId) {
        countQuery += ' AND ar.provider_id = ?';
        dataQuery += ' AND ar.provider_id = ?';
        params.push(options.providerId);
      }

      if (options?.model) {
        countQuery += ' AND ar.model = ?';
        dataQuery += ' AND ar.model = ?';
        params.push(options.model);
      }

      if (options?.startTime) {
        countQuery += ' AND ar.created_at >= ?';
        dataQuery += ' AND ar.created_at >= ?';
        params.push(options.startTime);
      }

      if (options?.endTime) {
        countQuery += ' AND ar.created_at <= ?';
        dataQuery += ' AND ar.created_at <= ?';
        params.push(options.endTime);
      }

      if (options?.status) {
        countQuery += ' AND ar.status = ?';
        dataQuery += ' AND ar.status = ?';
        params.push(options.status);
      }

      const [countRows] = await conn.query(countQuery, params);
      const total = (countRows as any[])[0].total;

      dataQuery += ' ORDER BY ar.created_at DESC LIMIT ? OFFSET ?';
      const dataParams = [...params, limit, offset];

      const [rows] = await conn.query(dataQuery, dataParams);

      return {
        data: rows,
        total,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        totalPages: Math.ceil(total / limit)
      };
    } finally {
      conn.release();
    }
  },

  async getById(id: string) {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT ar.*, ap.request_body AS payload_request_body, ap.response_body AS payload_response_body
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         LEFT JOIN api_request_payloads ap ON ap.request_id = ar.id
         WHERE ar.id = ? AND ${getDisableLoggingCondition()}`,
        [id]
      );
      const result = rows as any[];
      if (result.length === 0) return undefined;
      const row = result[0];
      row.request_body = row.payload_request_body ?? row.request_body;
      row.response_body = row.payload_response_body ?? row.response_body;
      delete row.payload_request_body;
      delete row.payload_response_body;
      return row;
    } finally {
      conn.release();
    }
  },

  async cleanOldRecords(daysToKeep: number = 30): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [compactResult] = await conn.query(
        `UPDATE api_requests ar
         LEFT JOIN api_request_payloads ap ON ap.request_id = ar.id
         SET ar.request_params_json = COALESCE(
               ar.request_params_json,
               CASE
                 WHEN JSON_VALID(COALESCE(ap.request_body, ar.request_body)) THEN JSON_OBJECT(
                   'temperature', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.temperature'),
                   'top_p', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.top_p'),
                   'max_tokens', COALESCE(JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.max_tokens'), JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.max_completion_tokens')),
                   'stream', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.stream'),
                   'tool_choice', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.tool_choice'),
                   'tools_count', JSON_LENGTH(JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.tools')),
                   'reasoning_effort', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.reasoning.effort'),
                   'user', JSON_EXTRACT(COALESCE(ap.request_body, ar.request_body), '$.user')
                 )
                 ELSE ar.request_params_json
               END
             ),
             ar.response_meta_json = COALESCE(
               ar.response_meta_json,
               CASE
                 WHEN JSON_VALID(COALESCE(ap.response_body, ar.response_body)) THEN JSON_OBJECT(
                   'status', JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.status'),
                   'finish_reason', JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.choices[0].finish_reason'),
                   'input_tokens', COALESCE(JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.input_tokens'), JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.prompt_tokens')),
                   'output_tokens', COALESCE(JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.output_tokens'), JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.completion_tokens')),
                   'cached_tokens', COALESCE(JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.input_tokens_details.cached_tokens'), JSON_EXTRACT(COALESCE(ap.response_body, ar.response_body), '$.usage.prompt_tokens_details.cached_tokens'))
                 )
                 ELSE ar.response_meta_json
               END
             ),
             ar.request_body = NULL,
             ar.response_body = NULL
         WHERE ar.created_at < ?
           AND (
             ar.request_body IS NOT NULL
             OR ar.response_body IS NOT NULL
             OR ap.request_id IS NOT NULL
             OR ar.request_params_json IS NULL
             OR ar.response_meta_json IS NULL
           )`,
        [cutoffTime]
      );

      const [result] = await conn.query(
        `DELETE ap
         FROM api_request_payloads ap
         INNER JOIN api_requests ar ON ar.id = ap.request_id
         WHERE ar.created_at < ?`,
        [cutoffTime]
      );

      const compactedRows = (compactResult as any).affectedRows || 0;
      const deletedPayloadRows = (result as any).affectedRows || 0;
      return Math.max(compactedRows, deletedPayloadRows);
    } finally {
      conn.release();
    }
  },

  async getModelStats(options: { startTime: number; endTime: number }) {
    const { startTime, endTime } = options;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          ar.model,
          p.name as provider_name,
          COUNT(*) as request_count,
          SUM(ar.total_tokens) as total_tokens,
          AVG(ar.response_time) as avg_response_time
        FROM api_requests ar
        LEFT JOIN providers p ON ar.provider_id = p.id
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ar.model IS NOT NULL AND ${loggingCondition}
        GROUP BY ar.model, p.name
        ORDER BY request_count DESC
        LIMIT 5`,
        [startTime, endTime]
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },

  async getModelResponseTimeStats(options: { startTime: number; endTime: number }) {
    const { startTime, endTime } = options;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT
          ar.model,
          ar.created_at,
          ar.response_time
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ?
          AND ar.status = 'success'
          AND ar.response_time > 0
          AND ${loggingCondition}
        ORDER BY ar.created_at DESC
        LIMIT 2000`,
        [startTime, endTime]
      );
      return rows as any[];
    } finally {
      conn.release();
    }
  },

  async getDbSize(): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
          ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb
        FROM information_schema.TABLES
        WHERE table_schema = DATABASE()`
      );
      const result = rows as any[];
      if (result.length === 0) return 0;
      return Number(result[0].size_mb) || 0;
    } finally {
      conn.release();
    }
  },

  async getDbUptime(): Promise<number> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
      const result = rows as any[];
      if (result.length === 0) return 0;
      return Number(result[0].Value) || 0;
    } finally {
      conn.release();
    }
  },

  async getPerformanceMetrics(options: { startTime: number; endTime: number }) {
    const { startTime, endTime } = options;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();

      // Query aggregated data by provider_id + model
      const [rows] = await conn.query(
        `SELECT
          ar.provider_id,
          p.name as provider_name,
          ar.model,
          COUNT(*) as request_count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as failure_count,
          AVG(CASE WHEN ar.tffb_ms >= 0 THEN ar.tffb_ms END) as avg_tffb_ms,
          COUNT(CASE WHEN ar.tffb_ms >= 0 THEN 1 END) as valid_tffb_count,
          AVG(CASE WHEN ar.response_time > 0 THEN ar.response_time END) as avg_response_time_ms,
          COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) as valid_response_time_count,
          AVG(CASE
            WHEN ar.completion_tokens > 0 AND ar.response_time > 0
            THEN CASE
              WHEN ar.tffb_ms IS NOT NULL AND ar.tffb_ms >= 0 AND (ar.response_time - ar.tffb_ms) > 0
                AND ar.completion_tokens / ((ar.response_time - ar.tffb_ms) / 1000.0) <= 1000
              THEN ar.completion_tokens / ((ar.response_time - ar.tffb_ms) / 1000.0)
              WHEN (ar.tffb_ms IS NULL OR ar.tffb_ms < 0 OR (ar.response_time - ar.tffb_ms) <= 0)
                AND ar.completion_tokens / (ar.response_time / 1000.0) <= 1000
              THEN ar.completion_tokens / (ar.response_time / 1000.0)
              ELSE NULL
            END
            ELSE NULL
          END) as avg_output_speed,
          COUNT(CASE
            WHEN ar.completion_tokens > 0 AND ar.response_time > 0
            THEN CASE
              WHEN ar.tffb_ms IS NOT NULL AND ar.tffb_ms >= 0 AND (ar.response_time - ar.tffb_ms) > 0
                AND ar.completion_tokens / ((ar.response_time - ar.tffb_ms) / 1000.0) <= 1000
              THEN 1
              WHEN (ar.tffb_ms IS NULL OR ar.tffb_ms < 0 OR (ar.response_time - ar.tffb_ms) <= 0)
                AND ar.completion_tokens / (ar.response_time / 1000.0) <= 1000
              THEN 1
              ELSE NULL
            END
            ELSE NULL
          END) as valid_speed_count,
          SUM(ar.prompt_tokens) as prompt_tokens,
          SUM(ar.completion_tokens) as completion_tokens,
          SUM(ar.cached_tokens) as cached_tokens,
          SUM(ar.total_tokens) as total_tokens
        FROM api_requests ar
        LEFT JOIN providers p ON ar.provider_id = p.id
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ar.model IS NOT NULL AND ${loggingCondition}
        GROUP BY ar.provider_id, ar.model, p.name
        ORDER BY request_count DESC`,
        [startTime, endTime]
      );

      const items = (rows as any[]).map(row => ({
        providerId: row.provider_id,
        providerName: row.provider_name || '未知供应商',
        model: row.model,
        requestCount: Number(row.request_count) || 0,
        successCount: Number(row.success_count) || 0,
        failureCount: Number(row.failure_count) || 0,
        availability: row.request_count > 0 ? Number(row.success_count) / Number(row.request_count) : 0,
        avgTffbMs: row.avg_tffb_ms !== null ? Number(row.avg_tffb_ms) : null,
        validTffbCount: Number(row.valid_tffb_count) || 0,
        avgResponseTimeMs: row.avg_response_time_ms !== null ? Number(row.avg_response_time_ms) : null,
        validResponseTimeCount: Number(row.valid_response_time_count) || 0,
        avgOutputSpeed: row.avg_output_speed !== null ? Number(row.avg_output_speed) : null,
        validSpeedCount: Number(row.valid_speed_count) || 0,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
        cachedTokens: Number(row.cached_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
      }));

      // Calculate summary from items
      const totalRequests = items.reduce((sum, item) => sum + item.requestCount, 0);
      const successCount = items.reduce((sum, item) => sum + item.successCount, 0);
      const failureCount = items.reduce((sum, item) => sum + item.failureCount, 0);

      // Calculate overall averages (weighted by valid sample count, not request count)
      const validTffbItems = items.filter(i => i.avgTffbMs !== null && i.validTffbCount > 0);
      const validResponseTimeItems = items.filter(i => i.avgResponseTimeMs !== null && i.validResponseTimeCount > 0);
      const validSpeedItems = items.filter(i => i.avgOutputSpeed !== null && i.validSpeedCount > 0);

      const avgTffbMs = validTffbItems.length > 0
        ? validTffbItems.reduce((sum, i) => sum + (i.avgTffbMs! * i.validTffbCount), 0) /
          validTffbItems.reduce((sum, i) => sum + i.validTffbCount, 0)
        : null;

      const avgResponseTimeMs = validResponseTimeItems.length > 0
        ? validResponseTimeItems.reduce((sum, i) => sum + (i.avgResponseTimeMs! * i.validResponseTimeCount), 0) /
          validResponseTimeItems.reduce((sum, i) => sum + i.validResponseTimeCount, 0)
        : null;

      const avgOutputSpeed = validSpeedItems.length > 0
        ? validSpeedItems.reduce((sum, i) => sum + (i.avgOutputSpeed! * i.validSpeedCount), 0) /
          validSpeedItems.reduce((sum, i) => sum + i.validSpeedCount, 0)
        : null;

      // Generate filters from items (same source ensures consistency)
      const providerMap = new Map<string, { label: string; value: string }>();
      const modelSet = new Set<string>();

      for (const item of items) {
        const providerValue = item.providerId ?? '__unknown_provider__';
        if (!providerMap.has(providerValue)) {
          providerMap.set(providerValue, {
            label: item.providerName,
            value: providerValue,
          });
        }
        modelSet.add(item.model);
      }

      const providers = Array.from(providerMap.values()).sort((a, b) => a.label.localeCompare(b.label));
      const models = Array.from(modelSet).map(m => ({ label: m, value: m })).sort((a, b) => a.label.localeCompare(b.label));

      return {
        items,
        summary: {
          totalRequests,
          successCount,
          failureCount,
          successRate: totalRequests > 0 ? successCount / totalRequests : 0,
          avgTffbMs,
          validTffbCount: validTffbItems.reduce((sum, i) => sum + i.validTffbCount, 0),
          avgOutputSpeed,
          avgResponseTimeMs,
        },
        filters: {
          providers,
          models,
        },
      };
    } finally {
      conn.release();
    }
  },
};
