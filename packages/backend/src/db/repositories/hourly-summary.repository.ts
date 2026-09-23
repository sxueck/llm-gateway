import { getDatabase } from "../connection.js";
import type { ResultSetHeader } from "mysql2";
import { getShanghaiDayStart } from "../utils/time-buckets.js";
import { appConfig } from "../../config/index.js";

/**
 * Hourly aggregation over api_requests backing the ops-monitoring exact
 * rolling windows. Buckets are (bucket_hour, virtual_key_id, provider_id,
 * model) rows with the SAME metric conventions as the daily summaries:
 *
 * - counts cover every request (status success/error only);
 * - prompt/completion/total tokens cover cache_hit = 0 rows only;
 * - cached_tokens / cache_hit_count / prompt_cache_hit_count cover all rows;
 * - tffb validity is tffb_ms >= 0; response_time validity is > 0;
 * - output speed is the per-row speed from getPerformanceMetrics (AVG of
 *   row speeds), stored as sum + sample count.
 *
 * A bucket is aggregated only once its whole hour is sealed AND still fully
 * covered by retained detail rows (bucket start >= detail retention start),
 * so every stored bucket is provably disjoint from the detail ranges the
 * read side still computes from api_requests.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Buckets are only sealed this long after their hour has ended. */
export const HOURLY_SEAL_DELAY_MS = 2 * HOUR_MS;

function getDetailStartInclusive(): number {
  return getShanghaiDayStart(-appConfig.apiRequestLogRetentionDays);
}

function floorToHour(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

const SPEED_CASE = `CASE
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
            END`;

const SPEED_VALID_CASE = `CASE
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
            END`;

export const hourlySummaryRepository = {
  /**
   * Aggregate every sealed, provable bucket in [from, to) with REPLACE
   * semantics: each pass recomputes whole buckets from retained detail, so
   * re-runs and overlap with cleanup are idempotent (never double-count).
   */
  async aggregateBucketRange(from: number, to: number): Promise<number> {
    if (to <= from) return 0;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `INSERT INTO api_request_hourly_summaries (
          bucket_hour,
          virtual_key_id,
          provider_id,
          model,
          request_count,
          success_count,
          error_count,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          cached_tokens,
          cache_hit_count,
          prompt_cache_hit_count,
          total_tffb_ms,
          tffb_count,
          total_response_time,
          response_time_count,
          total_output_speed,
          speed_count,
          last_used_at,
          created_at,
          updated_at
        )
        SELECT
          FLOOR(ar.created_at / ${HOUR_MS}) * ${HOUR_MS} AS bucket_hour,
          COALESCE(ar.virtual_key_id, '') AS virtual_key_id,
          COALESCE(ar.provider_id, '') AS provider_id,
          COALESCE(ar.model, '') AS model,
          COUNT(*) AS request_count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN ar.status != 'success' THEN 1 ELSE 0 END) AS error_count,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.prompt_tokens, 0) ELSE 0 END) AS prompt_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.completion_tokens, 0) ELSE 0 END) AS completion_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.total_tokens, 0) ELSE 0 END) AS total_tokens,
          SUM(COALESCE(ar.cached_tokens, 0)) AS cached_tokens,
          SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hit_count,
          SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) AS prompt_cache_hit_count,
          SUM(CASE WHEN ar.tffb_ms >= 0 THEN ar.tffb_ms ELSE 0 END) AS total_tffb_ms,
          COUNT(CASE WHEN ar.tffb_ms >= 0 THEN 1 END) AS tffb_count,
          SUM(CASE WHEN ar.response_time > 0 THEN ar.response_time ELSE 0 END) AS total_response_time,
          COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) AS response_time_count,
          COALESCE(SUM(${SPEED_CASE}), 0) AS total_output_speed,
          COUNT(${SPEED_VALID_CASE}) AS speed_count,
          MAX(ar.created_at) AS last_used_at,
          UNIX_TIMESTAMP() * 1000 AS created_at,
          UNIX_TIMESTAMP() * 1000 AS updated_at
        FROM api_requests ar
        WHERE ar.created_at >= ? AND ar.created_at < ?
        GROUP BY
          FLOOR(ar.created_at / ${HOUR_MS}) * ${HOUR_MS},
          COALESCE(ar.virtual_key_id, ''),
          COALESCE(ar.provider_id, ''),
          COALESCE(ar.model, '')
        ON DUPLICATE KEY UPDATE
          request_count = VALUES(request_count),
          success_count = VALUES(success_count),
          error_count = VALUES(error_count),
          prompt_tokens = VALUES(prompt_tokens),
          completion_tokens = VALUES(completion_tokens),
          total_tokens = VALUES(total_tokens),
          cached_tokens = VALUES(cached_tokens),
          cache_hit_count = VALUES(cache_hit_count),
          prompt_cache_hit_count = VALUES(prompt_cache_hit_count),
          total_tffb_ms = VALUES(total_tffb_ms),
          tffb_count = VALUES(tffb_count),
          total_response_time = VALUES(total_response_time),
          response_time_count = VALUES(response_time_count),
          total_output_speed = VALUES(total_output_speed),
          speed_count = VALUES(speed_count),
          last_used_at = VALUES(last_used_at),
          updated_at = UNIX_TIMESTAMP() * 1000`,
        [from, to],
      );
      return (result as ResultSetHeader).affectedRows || 0;
    } finally {
      conn.release();
    }
  },

  /** [firstBucketStart, lastBucketEnd) covered by stored hourly rows. */
  async getCoverageBounds(): Promise<{
    firstBucket: number | null;
    lastBucketEnd: number | null;
  }> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT MIN(bucket_hour) AS first_bucket, MAX(bucket_hour) AS last_bucket
         FROM api_request_hourly_summaries`,
      );
      const row = (rows as any[])[0] || {};
      const firstBucket =
        row.first_bucket !== null && row.first_bucket !== undefined
          ? Number(row.first_bucket)
          : null;
      const lastBucket =
        row.last_bucket !== null && row.last_bucket !== undefined
          ? Number(row.last_bucket)
          : null;
      return {
        firstBucket,
        lastBucketEnd: lastBucket !== null ? lastBucket + HOUR_MS : null,
      };
    } finally {
      conn.release();
    }
  },

  /**
   * Advance the aggregation watermark: seal everything from the hour after
   * the last stored bucket up to (now - seal delay). The range is clamped to
   * detail retention: buckets starting before detailStart can no longer be
   * recomputed from complete detail and must stay absent instead of being
   * fabricated from partial rows.
   */
  async aggregateSealedBuckets(): Promise<{
    from: number | null;
    to: number | null;
    touchedRows: number;
  }> {
    const now = Date.now();
    const sealEnd = floorToHour(now - HOURLY_SEAL_DELAY_MS);
    const detailStartHour = floorToHour(getDetailStartInclusive());

    const bounds = await this.getCoverageBounds();

    let from: number;
    if (bounds.lastBucketEnd !== null) {
      from = bounds.lastBucketEnd;
    } else {
      // First run after upgrade: backfill starts at the oldest retained detail.
      const pool = getDatabase();
      const conn = await pool.getConnection();
      let oldestDetail: number | null;
      try {
        const [rows] = await conn.query(
          `SELECT MIN(created_at) AS oldest FROM api_requests`,
        );
        const row = (rows as any[])[0] || {};
        oldestDetail =
          row.oldest !== null && row.oldest !== undefined
            ? Number(row.oldest)
            : null;
      } finally {
        conn.release();
      }
      if (oldestDetail === null) {
        return { from: null, to: null, touchedRows: 0 };
      }
      from = floorToHour(oldestDetail);
    }

    // Buckets older than retained detail are unprovable: skip them forever.
    if (from < detailStartHour) {
      from = detailStartHour;
    }
    const to = sealEnd;
    if (to <= from) {
      return { from: null, to: null, touchedRows: 0 };
    }

    const touchedRows = await this.aggregateBucketRange(from, to);
    return { from, to, touchedRows };
  },
};
