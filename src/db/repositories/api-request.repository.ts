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
        SELECT ar.*
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ${loggingCondition}
      `;
      const params: any[] = [];

      if (options?.virtualKeyId) {
        countQuery += ' AND ar.virtual_key_id = ?';
        dataQuery += ' AND ar.virtual_key_id = ?';
        params.push(options.virtualKeyId);
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
        `SELECT ar.*
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.id = ? AND ${getDisableLoggingCondition()}`,
        [id]
      );
      const result = rows as any[];
      if (result.length === 0) return undefined;
      return result[0];
    } finally {
      conn.release();
    }
  },

  async cleanOldRecords(daysToKeep: number = 30): Promise<number> {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        'UPDATE api_requests SET request_body = NULL, response_body = NULL WHERE created_at < ? AND (request_body IS NOT NULL OR response_body IS NOT NULL)',
        [cutoffTime]
      );
      return (result as any).affectedRows || 0;
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
};
