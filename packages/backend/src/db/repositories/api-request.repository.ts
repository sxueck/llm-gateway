import { getDatabase } from '../connection.js';
import { ApiRequestBuffer } from '../types.js';
import { addToBuffer, shouldFlush, flushApiRequestBuffer } from '../utils/buffer.js';
import { generateTimeBuckets, generateShanghaiDayBuckets, initializeTimeBuckets, getShanghaiDayStart } from '../utils/time-buckets.js';
import { debugModeService } from '../../services/debug-mode.js';
import { appConfig } from '../../config/index.js';

function getDisableLoggingCondition(): string {
  return '(ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)';
}

function getDisableLoggingConditionForSummary(tableAlias: string = 's'): string {
  return `(${tableAlias}.virtual_key_id = '' OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)`;
}

function getDetailStartInclusive(): number {
  return getShanghaiDayStart(-appConfig.apiRequestLogRetentionDays);
}

export const apiRequestRepository = {
  async create(request: ApiRequestBuffer): Promise<void> {
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
      const detailStart = getDetailStartInclusive();
      const needsSummary = startTime < detailStart;
      const needsDetail = endTime >= detailStart;

      let totalRequests = 0;
      let successfulRequests = 0;
      let failedRequests = 0;
      let totalTokens = 0;
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens = 0;
      let totalResponseTime = 0;
      let responseTimeCount = 0;
      let cacheHits = 0;
      let promptCacheHits = 0;

      if (needsSummary) {
        const summaryLoggingCondition = getDisableLoggingConditionForSummary('s');
        const lastSummaryDay = new Date(detailStart - 1);

        const [summaryRows] = await conn.query(
          `SELECT
            SUM(s.request_count) as total_requests,
            SUM(s.success_count) as successful_requests,
            SUM(s.error_count) as failed_requests,
            SUM(s.total_tokens) as total_tokens,
            SUM(s.prompt_tokens) as prompt_tokens,
            SUM(s.completion_tokens) as completion_tokens,
            SUM(s.cached_tokens) as cached_tokens,
            SUM(s.total_response_time) as total_response_time,
            SUM(s.response_time_count) as response_time_count,
            SUM(s.cache_hit_count) as cache_hits,
            SUM(s.prompt_cache_hit_count) as prompt_cache_hits
          FROM api_request_daily_summaries s
          LEFT JOIN virtual_keys vk ON s.virtual_key_id = vk.id
          WHERE s.summary_date >= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND s.summary_date <= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND ${summaryLoggingCondition}`,
          [startTime, lastSummaryDay.getTime()]
        );

        const summary = (summaryRows as any[])[0];
        if (summary) {
          totalRequests += Number(summary.total_requests) || 0;
          successfulRequests += Number(summary.successful_requests) || 0;
          failedRequests += Number(summary.failed_requests) || 0;
          totalTokens += Number(summary.total_tokens) || 0;
          promptTokens += Number(summary.prompt_tokens) || 0;
          completionTokens += Number(summary.completion_tokens) || 0;
          cachedTokens += Number(summary.cached_tokens) || 0;
          totalResponseTime += Number(summary.total_response_time) || 0;
          responseTimeCount += Number(summary.response_time_count) || 0;
          cacheHits += Number(summary.cache_hits) || 0;
          promptCacheHits += Number(summary.prompt_cache_hits) || 0;
        }
      }

      // Query detail table for recent data
      if (needsDetail) {
        const detailStartTime = Math.max(startTime, detailStart);
        const loggingCondition = getDisableLoggingCondition();

        const [detailRows] = await conn.query(
          `SELECT
            COUNT(*) as total_requests,
            SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) as successful_requests,
            SUM(CASE WHEN ar.status = 'error' THEN 1 ELSE 0 END) as failed_requests,
            SUM(CASE WHEN ar.cache_hit = 0 THEN ar.total_tokens ELSE 0 END) as total_tokens,
            SUM(CASE WHEN ar.cache_hit = 0 THEN ar.prompt_tokens ELSE 0 END) as prompt_tokens,
            SUM(CASE WHEN ar.cache_hit = 0 THEN ar.completion_tokens ELSE 0 END) as completion_tokens,
            SUM(ar.cached_tokens) as cached_tokens,
            SUM(ar.response_time) as total_response_time,
            COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) as response_time_count,
            SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) as cache_hits,
            SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) as prompt_cache_hits
          FROM api_requests ar
          LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
          WHERE ar.created_at >= ? AND ar.created_at <= ? AND ${loggingCondition}`,
          [detailStartTime, endTime]
        );

        const detail = (detailRows as any[])[0];
        if (detail) {
          totalRequests += Number(detail.total_requests) || 0;
          successfulRequests += Number(detail.successful_requests) || 0;
          failedRequests += Number(detail.failed_requests) || 0;
          totalTokens += Number(detail.total_tokens) || 0;
          promptTokens += Number(detail.prompt_tokens) || 0;
          completionTokens += Number(detail.completion_tokens) || 0;
          cachedTokens += Number(detail.cached_tokens) || 0;
          totalResponseTime += Number(detail.total_response_time) || 0;
          responseTimeCount += Number(detail.response_time_count) || 0;
          cacheHits += Number(detail.cache_hits) || 0;
          promptCacheHits += Number(detail.prompt_cache_hits) || 0;
        }
      }

      const avgResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;

      return {
        totalRequests,
        successfulRequests,
        failedRequests,
        totalTokens,
        promptTokens,
        completionTokens,
        cachedTokens,
        avgResponseTime,
        cacheHits,
        promptCacheHits,
        cacheSavedTokens: 0,
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
    const isDayInterval = interval === 'day';

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const useMixedRead = isDayInterval;
      const detailStart = useMixedRead ? getDetailStartInclusive() : startTime;
      const needsSummary = useMixedRead && startTime < detailStart;
      const needsDetail = !useMixedRead || endTime >= detailStart;

      const virtualKeyMap = new Map<string, { id: string; name: string }>();
      const dataByKey = new Map<string, Map<number, any>>();
      const timePoints = isDayInterval
        ? generateShanghaiDayBuckets(startTime, endTime)
        : generateTimeBuckets(startTime, endTime, intervalMs);

      if (needsSummary) {
        const lastSummaryDay = new Date(detailStart - 1);
        const summaryEndTimestamp = lastSummaryDay.getTime();
        const summaryLoggingCondition = getDisableLoggingConditionForSummary('s');

        const [summaryRows] = await conn.query(
          `SELECT
            UNIX_TIMESTAMP(s.summary_date - INTERVAL 8 HOUR) * 1000 as time_bucket,
            s.virtual_key_id,
            vk.name as virtual_key_name,
            SUM(s.request_count) as count,
            SUM(s.success_count) as success_count,
            SUM(s.error_count) as error_count,
            SUM(s.total_tokens) as total_tokens
          FROM api_request_daily_summaries s
          LEFT JOIN virtual_keys vk ON s.virtual_key_id = vk.id
          WHERE s.summary_date >= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND s.summary_date <= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND ${summaryLoggingCondition}
          GROUP BY s.summary_date, s.virtual_key_id`,
          [startTime, summaryEndTimestamp]
        );

        (summaryRows as any[]).forEach(row => {
          const keyId = row.virtual_key_id || 'unknown';
          const keyName = row.virtual_key_name || '未知密钥';

          if (!virtualKeyMap.has(keyId)) {
            virtualKeyMap.set(keyId, { id: keyId, name: keyName });
          }

          if (!dataByKey.has(keyId)) {
            dataByKey.set(keyId, initializeTimeBuckets(timePoints));
          }

          const bucket = Number(row.time_bucket);
          if (!bucket || isNaN(bucket)) return;

          const keyBuckets = dataByKey.get(keyId)!;
          if (keyBuckets.has(bucket)) {
            const existing = keyBuckets.get(bucket);
            keyBuckets.set(bucket, {
              timestamp: bucket,
              requestCount: existing.requestCount + (Number(row.count) || 0),
              successCount: existing.successCount + (Number(row.success_count) || 0),
              errorCount: existing.errorCount + (Number(row.error_count) || 0),
              tokenCount: existing.tokenCount + (Number(row.total_tokens) || 0)
            });
          }
        });
      }

      if (needsDetail) {
        const detailStartTime = useMixedRead ? Math.max(startTime, detailStart) : startTime;
        const loggingCondition = getDisableLoggingCondition();

        const bucketExpression = isDayInterval
          ? `FLOOR((ar.created_at + ${8 * 60 * 60 * 1000}) / ?) * ? - ${8 * 60 * 60 * 1000}`
          : 'FLOOR(ar.created_at / ?) * ?';
        const queryParams = isDayInterval
          ? [intervalMs, intervalMs, detailStartTime, endTime]
          : [intervalMs, intervalMs, detailStartTime, endTime];

        const [detailRows] = await conn.query(
          `SELECT
            ${bucketExpression} as time_bucket,
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
          queryParams
        );

        (detailRows as any[]).forEach(row => {
          const keyId = row.virtual_key_id || 'unknown';
          const keyName = row.virtual_key_name || '未知密钥';

          if (!virtualKeyMap.has(keyId)) {
            virtualKeyMap.set(keyId, { id: keyId, name: keyName });
          }

          if (!dataByKey.has(keyId)) {
            dataByKey.set(keyId, initializeTimeBuckets(timePoints));
          }

          const bucket = Number(row.time_bucket);
          if (!bucket || isNaN(bucket)) return;

          const keyBuckets = dataByKey.get(keyId)!;
          if (keyBuckets.has(bucket)) {
            const existing = keyBuckets.get(bucket);
            keyBuckets.set(bucket, {
              timestamp: bucket,
              requestCount: existing.requestCount + (Number(row.count) || 0),
              successCount: existing.successCount + (Number(row.success_count) || 0),
              errorCount: existing.errorCount + (Number(row.error_count) || 0),
              tokenCount: existing.tokenCount + (Number(row.total_tokens) || 0)
            });
          }
        });
      }

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
          ar.tfft_ms,
          ar.tffb_ms,
          ar.error_message,
          ar.request_params_json,
          ar.response_meta_json,
          ar.cache_hit,
          ar.request_type,
          ar.compression_original_tokens,
          ar.compression_saved_tokens,
          ar.ip,
          ar.user_agent,
          ar.created_at
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

  async cleanOldRecords(daysToKeep: number = 7): Promise<{ summarizedCount: number; deletedPayloadCount: number; deletedRequestCount: number; deletedCount: number }> {
    const now = new Date();
    const shanghaiOffset = 8 * 60 * 60 * 1000;
    const shanghaiNow = new Date(now.getTime() + shanghaiOffset);

    const retainedDate = new Date(shanghaiNow);
    retainedDate.setUTCDate(retainedDate.getUTCDate() - daysToKeep);
    retainedDate.setUTCHours(0, 0, 0, 0);

    const cutoffTime = retainedDate.getTime() - shanghaiOffset;

    const pool = getDatabase();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const [candidateCountResult] = await conn.query(
        `SELECT COUNT(*) as candidate_count
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.created_at < ?
           AND (ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)`,
        [cutoffTime]
      );
      const summarizedCount = Number((candidateCountResult as any[])[0]?.candidate_count) || 0;

      await conn.query(
        `INSERT INTO api_request_daily_summaries (
          summary_date,
          virtual_key_id,
          provider_id,
          model,
          request_count,
          success_count,
          error_count,
          total_tokens,
          prompt_tokens,
          completion_tokens,
          cached_tokens,
          cache_hit_count,
          prompt_cache_hit_count,
          total_response_time,
          response_time_count,
          created_at,
          updated_at
        )
        SELECT
          DATE(FROM_UNIXTIME(ar.created_at / 1000) + INTERVAL 8 HOUR) AS summary_date,
          COALESCE(ar.virtual_key_id, '') AS virtual_key_id,
          COALESCE(ar.provider_id, '') AS provider_id,
          COALESCE(ar.model, '') AS model,
          COUNT(*) AS request_count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN ar.status != 'success' THEN 1 ELSE 0 END) AS error_count,
          SUM(COALESCE(ar.total_tokens, 0)) AS total_tokens,
          SUM(COALESCE(ar.prompt_tokens, 0)) AS prompt_tokens,
          SUM(COALESCE(ar.completion_tokens, 0)) AS completion_tokens,
          SUM(COALESCE(ar.cached_tokens, 0)) AS cached_tokens,
          SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hit_count,
          SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) AS prompt_cache_hit_count,
          SUM(COALESCE(ar.response_time, 0)) AS total_response_time,
          COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) AS response_time_count,
          UNIX_TIMESTAMP() * 1000 AS created_at,
          UNIX_TIMESTAMP() * 1000 AS updated_at
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at < ?
          AND (ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)
        GROUP BY
          DATE(FROM_UNIXTIME(ar.created_at / 1000) + INTERVAL 8 HOUR),
          COALESCE(ar.virtual_key_id, ''),
          COALESCE(ar.provider_id, ''),
          COALESCE(ar.model, '')
        ON DUPLICATE KEY UPDATE
          request_count = request_count + VALUES(request_count),
          success_count = success_count + VALUES(success_count),
          error_count = error_count + VALUES(error_count),
          total_tokens = total_tokens + VALUES(total_tokens),
          prompt_tokens = prompt_tokens + VALUES(prompt_tokens),
          completion_tokens = completion_tokens + VALUES(completion_tokens),
          cached_tokens = cached_tokens + VALUES(cached_tokens),
          cache_hit_count = cache_hit_count + VALUES(cache_hit_count),
          prompt_cache_hit_count = prompt_cache_hit_count + VALUES(prompt_cache_hit_count),
          total_response_time = total_response_time + VALUES(total_response_time),
          response_time_count = response_time_count + VALUES(response_time_count),
          updated_at = UNIX_TIMESTAMP() * 1000`,
        [cutoffTime]
      );

      const [payloadDeleteResult] = await conn.query(
        `DELETE ap
         FROM api_request_payloads ap
         INNER JOIN api_requests ar ON ar.id = ap.request_id
         WHERE ar.created_at < ?`,
        [cutoffTime]
      );

      const [requestDeleteResult] = await conn.query(
        `DELETE ar
         FROM api_requests ar
         WHERE ar.created_at < ?`,
        [cutoffTime]
      );

      await conn.commit();

      const deletedPayloadCount = (payloadDeleteResult as any).affectedRows || 0;
      const deletedRequestCount = (requestDeleteResult as any).affectedRows || 0;

      return {
        summarizedCount,
        deletedPayloadCount,
        deletedRequestCount,
        deletedCount: deletedRequestCount
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  },

  async getModelStats(options: { startTime: number; endTime: number }) {
    const { startTime, endTime } = options;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const detailStart = getDetailStartInclusive();
      const needsSummary = startTime < detailStart;
      const needsDetail = endTime >= detailStart;

      const modelStats = new Map<string, {
        model: string;
        providerName: string;
        requestCount: number;
        totalTokens: number;
        totalResponseTime: number;
        responseTimeCount: number;
      }>();

      if (needsSummary) {
        const summaryLoggingCondition = getDisableLoggingConditionForSummary('s');
        const lastSummaryDay = new Date(detailStart - 1);

        const [summaryRows] = await conn.query(
          `SELECT
            COALESCE(s.model, '') as model,
            COALESCE(p.name, '未知供应商') as provider_name,
            COALESCE(s.provider_id, '') as provider_id,
            SUM(s.request_count) as request_count,
            SUM(s.total_tokens) as total_tokens,
            SUM(s.total_response_time) as total_response_time,
            SUM(s.response_time_count) as response_time_count
          FROM api_request_daily_summaries s
          LEFT JOIN providers p ON s.provider_id = p.id
          LEFT JOIN virtual_keys vk ON s.virtual_key_id = vk.id
          WHERE s.summary_date >= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND s.summary_date <= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND s.model != ''
            AND ${summaryLoggingCondition}
          GROUP BY s.model, p.name, s.provider_id`,
          [startTime, lastSummaryDay.getTime()]
        );

        (summaryRows as any[]).forEach(row => {
          const key = `${row.model}|${row.provider_name}`;
          modelStats.set(key, {
            model: row.model,
            providerName: row.provider_name || '未知供应商',
            requestCount: Number(row.request_count) || 0,
            totalTokens: Number(row.total_tokens) || 0,
            totalResponseTime: Number(row.total_response_time) || 0,
            responseTimeCount: Number(row.response_time_count) || 0,
          });
        });
      }

      // Query detail table for recent data
      if (needsDetail) {
        const detailStartTime = Math.max(startTime, detailStart);
        const loggingCondition = getDisableLoggingCondition();

        const [detailRows] = await conn.query(
          `SELECT
            ar.model,
            p.name as provider_name,
            COUNT(*) as request_count,
            SUM(ar.total_tokens) as total_tokens,
            AVG(ar.response_time) as avg_response_time,
            SUM(ar.response_time) as total_response_time,
            COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) as response_time_count
          FROM api_requests ar
          LEFT JOIN providers p ON ar.provider_id = p.id
          LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
          WHERE ar.created_at >= ? AND ar.created_at <= ?
            AND ar.model IS NOT NULL AND ${loggingCondition}
          GROUP BY ar.model, p.name`,
          [detailStartTime, endTime]
        );

        (detailRows as any[]).forEach(row => {
          const key = `${row.model}|${row.provider_name || '未知供应商'}`;
          const existing = modelStats.get(key);

          if (existing) {
            existing.requestCount += Number(row.request_count) || 0;
            existing.totalTokens += Number(row.total_tokens) || 0;
            existing.totalResponseTime += Number(row.total_response_time) || 0;
            existing.responseTimeCount += Number(row.response_time_count) || 0;
          } else {
            modelStats.set(key, {
              model: row.model,
              providerName: row.provider_name || '未知供应商',
              requestCount: Number(row.request_count) || 0,
              totalTokens: Number(row.total_tokens) || 0,
              totalResponseTime: Number(row.total_response_time) || 0,
              responseTimeCount: Number(row.response_time_count) || 0,
            });
          }
        });
      }

      const results = Array.from(modelStats.values())
        .map(stat => ({
          model: stat.model,
          provider_name: stat.providerName,
          request_count: stat.requestCount,
          total_tokens: stat.totalTokens,
          avg_response_time: stat.responseTimeCount > 0
            ? stat.totalResponseTime / stat.responseTimeCount
            : 0,
        }))
        .sort((a, b) => b.request_count - a.request_count)
        .slice(0, 5);

      return results;
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

  async getPiiProtectionCount(options?: { startTime?: number; endTime?: number }): Promise<number> {
    const now = Date.now();
    const startTime = options?.startTime ?? (now - 24 * 60 * 60 * 1000);
    const endTime = options?.endTime || now;

    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const loggingCondition = getDisableLoggingCondition();
      const [rows] = await conn.query(
        `SELECT COUNT(*) as pii_protection_count
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.created_at >= ? AND ar.created_at <= ?
           AND ${loggingCondition}
           AND JSON_EXTRACT(ar.request_params_json, '$.pii_masked_count') > 0`,
        [startTime, endTime]
      );
      const result = rows as any[];
      if (result.length === 0) return 0;
      return result[0].pii_protection_count || 0;
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
        LEFT JOIN models m ON vk.model_id = m.id
        WHERE ar.created_at >= ? AND ar.created_at <= ? AND ar.model IS NOT NULL AND ${loggingCondition}
          AND (m.is_virtual IS NULL OR m.is_virtual = 0)
          AND (m.expert_routing_id IS NULL)
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
