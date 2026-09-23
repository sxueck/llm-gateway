import { getDatabase } from "../connection.js";

/**
 * Unified ops-monitoring aggregation reads.
 *
 * One metric convention feeds the ops page and the homepage rolling windows
 * (PRD 7.1/7.3). Reads are split into provable segments:
 *
 * - HOURLY segment: api_request_hourly_summaries rows for sealed full hours;
 * - DETAIL segment: api_requests rows for everything else (unsealed hours
 *   and partial boundary hours);
 * - regions below both detail retention and hourly coverage are NOT read:
 *   they are reported as coverage gaps instead of being approximated.
 *
 * disable_logging keys are included (their sensitive metadata was suppressed
 * on write); token sums cover cache_hit = 0 rows only, cached_tokens covers
 * all rows — identical to getStats' detail side and the cleanup writer.
 */

export interface OpsFilters {
  virtualKeyId?: string;
  model?: string;
  providerId?: string;
}

export type OpsDimension = "virtualKey" | "model" | "provider";

export interface SegmentRange {
  from: number;
  to: number;
}

export type DimensionTotalsRow = SegmentTotalsRow & {
  dimension_key: string;
  display_name: string | null;
  /** Server-side key mask for the virtualKey dimension; never the raw value. */
  masked_key?: string | null;
};

export interface SegmentTotalsRow {
  request_count: number;
  success_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_hit_count: number;
  prompt_cache_hit_count: number;
  tffb_sum: number;
  tffb_count: number;
  response_time_sum: number;
  response_time_count: number;
  speed_sum: number;
  speed_count: number;
  last_used_at: number | null;
}

function filterConditions(
  prefix: string,
  filters: OpsFilters,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.virtualKeyId) {
    conditions.push(`${prefix}.virtual_key_id = ?`);
    params.push(filters.virtualKeyId);
  }
  if (filters.model) {
    conditions.push(`${prefix}.model = ?`);
    params.push(filters.model);
  }
  if (filters.providerId) {
    conditions.push(`${prefix}.provider_id = ?`);
    params.push(filters.providerId);
  }
  return {
    sql: conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

/** Per-request output speed, identical CASE to getPerformanceMetrics. */
const DETAIL_SPEED_SUM = `COALESCE(SUM(CASE
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
            END), 0)`;

const DETAIL_SPEED_COUNT = `COUNT(CASE
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
            END)`;

const DETAIL_TOTALS = `COUNT(*) AS request_count,
          SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.prompt_tokens, 0) ELSE 0 END) AS prompt_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.completion_tokens, 0) ELSE 0 END) AS completion_tokens,
          SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.total_tokens, 0) ELSE 0 END) AS total_tokens,
          SUM(COALESCE(ar.cached_tokens, 0)) AS cached_tokens,
          SUM(CASE WHEN ar.cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hit_count,
          SUM(CASE WHEN ar.cached_tokens > 0 THEN 1 ELSE 0 END) AS prompt_cache_hit_count,
          SUM(CASE WHEN ar.tffb_ms >= 0 THEN ar.tffb_ms ELSE 0 END) AS tffb_sum,
          COUNT(CASE WHEN ar.tffb_ms >= 0 THEN 1 END) AS tffb_count,
          SUM(CASE WHEN ar.response_time > 0 THEN ar.response_time ELSE 0 END) AS response_time_sum,
          COUNT(CASE WHEN ar.response_time > 0 THEN 1 END) AS response_time_count,
          ${DETAIL_SPEED_SUM} AS speed_sum,
          ${DETAIL_SPEED_COUNT} AS speed_count,
          MAX(ar.created_at) AS last_used_at`;

const HOURLY_TOTALS = `SUM(h.request_count) AS request_count,
          SUM(h.success_count) AS success_count,
          SUM(h.prompt_tokens) AS prompt_tokens,
          SUM(h.completion_tokens) AS completion_tokens,
          SUM(h.total_tokens) AS total_tokens,
          SUM(h.cached_tokens) AS cached_tokens,
          SUM(h.cache_hit_count) AS cache_hit_count,
          SUM(h.prompt_cache_hit_count) AS prompt_cache_hit_count,
          SUM(h.total_tffb_ms) AS tffb_sum,
          SUM(h.tffb_count) AS tffb_count,
          SUM(h.total_response_time) AS response_time_sum,
          SUM(h.response_time_count) AS response_time_count,
          SUM(h.total_output_speed) AS speed_sum,
          SUM(h.speed_count) AS speed_count,
          MAX(h.last_used_at) AS last_used_at`;

export const opsMetricsRepository = {
  /** Totals over the detail segment [from, to). */
  async getDetailTotals(
    range: SegmentRange,
    filters: OpsFilters,
  ): Promise<SegmentTotalsRow | null> {
    if (range.to <= range.from) return null;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const filter = filterConditions("ar", filters);
      const [rows] = await conn.query(
        `SELECT ${DETAIL_TOTALS}
         FROM api_requests ar
         WHERE ar.created_at >= ? AND ar.created_at < ?${filter.sql}`,
        [range.from, range.to, ...filter.params],
      );
      const row = (rows as any[])[0];
      return row && Number(row.request_count) > 0
        ? (numericRow(row) as SegmentTotalsRow)
        : null;
    } finally {
      conn.release();
    }
  },

  /** Totals over the sealed-hourly segment [from, to). */
  async getHourlyTotals(
    range: SegmentRange,
    filters: OpsFilters,
  ): Promise<SegmentTotalsRow | null> {
    if (range.to <= range.from) return null;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const filter = filterConditions("h", filters);
      const [rows] = await conn.query(
        `SELECT ${HOURLY_TOTALS}
         FROM api_request_hourly_summaries h
         WHERE h.bucket_hour >= ? AND h.bucket_hour < ?${filter.sql}`,
        [range.from, range.to, ...filter.params],
      );
      const row = (rows as any[])[0];
      return row && Number(row.request_count) > 0
        ? {
            ...row,
            // Stored sums come back as strings for BIGINT/DOUBLE aggregates.
            request_count: Number(row.request_count),
            success_count: Number(row.success_count),
            prompt_tokens: Number(row.prompt_tokens),
            completion_tokens: Number(row.completion_tokens),
            total_tokens: Number(row.total_tokens),
            cached_tokens: Number(row.cached_tokens),
            cache_hit_count: Number(row.cache_hit_count),
            prompt_cache_hit_count: Number(row.prompt_cache_hit_count),
            tffb_sum: Number(row.tffb_sum),
            tffb_count: Number(row.tffb_count),
            response_time_sum: Number(row.response_time_sum),
            response_time_count: Number(row.response_time_count),
            speed_sum: Number(row.speed_sum),
            speed_count: Number(row.speed_count),
          }
        : null;
    } finally {
      conn.release();
    }
  },

  /**
   * Totals per bucket, grouped in ONE query per table. Only the ranges listed
   * in `ranges` are read, so the caller can exclude hourly-covered spans from
   * the detail side (and vice versa) without double-counting. `floorMs`/
   * `offsetMs` define the bucket key: hour buckets use floorMs=3600000,
   * offset=0; Shanghai day buckets use floorMs=86400000, offset=+8h.
   */
  async getDetailTotalsGroupedByBucket(
    ranges: SegmentRange[],
    floorMs: number,
    offsetMs: number,
    filters: OpsFilters,
  ): Promise<Map<number, SegmentTotalsRow>> {
    const result = new Map<number, SegmentTotalsRow>();
    const usable = ranges.filter((r) => r.to > r.from);
    if (usable.length === 0) return result;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const rangeSql = usable
        .map(() => `(ar.created_at >= ? AND ar.created_at < ?)`)
        .join(" OR ");
      const rangeParams: unknown[] = [];
      for (const r of usable) {
        rangeParams.push(r.from, r.to);
      }
      const filter = filterConditions("ar", filters);
      const bucketExpr = `FLOOR((ar.created_at + ${offsetMs}) / ${floorMs}) * ${floorMs} - ${offsetMs}`;
      const [rows] = await conn.query(
        `SELECT ${bucketExpr} AS bucket_start, ${DETAIL_TOTALS}
         FROM api_requests ar
         WHERE (${rangeSql})${filter.sql}
         GROUP BY ${bucketExpr}`,
        [...rangeParams, ...filter.params],
      );
      for (const row of rows as any[]) {
        if (Number(row.request_count) > 0) {
          result.set(Number(row.bucket_start), numericRow(row));
        }
      }
    } finally {
      conn.release();
    }
    return result;
  },

  /** Same grouping over the sealed-hourly segment [from, to). */
  async getHourlyTotalsGroupedByBucket(
    range: SegmentRange,
    floorMs: number,
    offsetMs: number,
    filters: OpsFilters,
  ): Promise<Map<number, SegmentTotalsRow>> {
    const result = new Map<number, SegmentTotalsRow>();
    if (range.to <= range.from) return result;
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const filter = filterConditions("h", filters);
      const bucketExpr = `FLOOR((h.bucket_hour + ${offsetMs}) / ${floorMs}) * ${floorMs} - ${offsetMs}`;
      const [rows] = await conn.query(
        `SELECT ${bucketExpr} AS bucket_start, ${HOURLY_TOTALS}
         FROM api_request_hourly_summaries h
         WHERE h.bucket_hour >= ? AND h.bucket_hour < ?${filter.sql}
         GROUP BY ${bucketExpr}`,
        [range.from, range.to, ...filter.params],
      );
      for (const row of rows as any[]) {
        if (Number(row.request_count) > 0) {
          result.set(Number(row.bucket_start), numericRow(row));
        }
      }
    } finally {
      conn.release();
    }
    return result;
  },

  /**
   * Dimension aggregation over one segment. `dimension` picks the group key;
   * joins bring in display names (never key material). `search` filters by
   * display name / model substring. Rows are capped at `limit` aggregated
   * groups to bound query cost; ordering/pagination happens on the merged
   * result in the service layer.
   */
  async getDimensionTotals(
    segment: { kind: "detail" | "hourly"; range: SegmentRange },
    dimension: OpsDimension,
    filters: OpsFilters,
    search: string | undefined,
    limit: number,
  ): Promise<DimensionTotalsRow[]> {
    const { kind, range } = segment;
    if (range.to <= range.from) return [] as DimensionTotalsRow[];
    const pool = getDatabase();
    const conn = await pool.getConnection();

    const groupExpr =
      kind === "detail"
        ? dimension === "virtualKey"
          ? "COALESCE(ar.virtual_key_id, '')"
          : dimension === "provider"
            ? "COALESCE(ar.provider_id, '')"
            : "COALESCE(ar.model, '')"
        : dimension === "virtualKey"
          ? "h.virtual_key_id"
          : dimension === "provider"
            ? "h.provider_id"
            : "h.model";

    let joinSql = "";
    let searchSql = "";
    const params: unknown[] = [range.from, range.to];
    if (dimension === "virtualKey") {
      joinSql =
        " LEFT JOIN virtual_keys vk ON " +
        (kind === "detail"
          ? "ar.virtual_key_id = vk.id"
          : "h.virtual_key_id = vk.id");
      if (search) {
        searchSql = " AND vk.name LIKE ?";
        params.push(`%${search}%`);
      }
    } else if (dimension === "provider") {
      joinSql =
        " LEFT JOIN providers p ON " +
        (kind === "detail" ? "ar.provider_id = p.id" : "h.provider_id = p.id");
      if (search) {
        searchSql = " AND p.name LIKE ?";
        params.push(`%${search}%`);
      }
    } else if (search) {
      const col = kind === "detail" ? "ar.model" : "h.model";
      searchSql = ` AND ${col} LIKE ?`;
      params.push(`%${search}%`);
    }

    const filter = filterConditions(kind === "detail" ? "ar" : "h", filters);
    const totals = kind === "detail" ? DETAIL_TOTALS : HOURLY_TOTALS;
    const maskExpr =
      dimension === "virtualKey"
        ? "IF(vk.id IS NULL, NULL, IF(CHAR_LENGTH(vk.key_value) <= 8, '***', CONCAT('***', RIGHT(vk.key_value, 4))))"
        : null;
    const selectExtra = maskExpr ? `, ${maskExpr} AS masked_key` : "";
    const groupExtra =
      dimension === "virtualKey"
        ? ", vk.name" + (maskExpr ? `, ${maskExpr}` : "")
        : dimension === "provider"
          ? ", p.name"
          : "";

    try {
      const [rows] = await conn.query(
        `SELECT ${groupExpr} AS dimension_key,
                ${dimension === "virtualKey" ? "vk.name" : dimension === "provider" ? "p.name" : "NULL"} AS display_name${selectExtra},
                ${totals}
         FROM ${kind === "detail" ? "api_requests ar" : "api_request_hourly_summaries h"}${joinSql}
         WHERE ${kind === "detail" ? "ar.created_at" : "h.bucket_hour"} >= ?
           AND ${kind === "detail" ? "ar.created_at" : "h.bucket_hour"} < ?${searchSql}${filter.sql}
         GROUP BY ${groupExpr}${groupExtra}
         LIMIT ?`,
        [...params, ...filter.params, limit],
      );
      return (rows as any[]).map(
        (row) => numericRow(row) as DimensionTotalsRow,
      );
    } finally {
      conn.release();
    }
  },
};

function numericRow(
  row: any,
): SegmentTotalsRow & { dimension_key?: string; display_name?: string | null } {
  return {
    ...row,
    request_count: Number(row.request_count) || 0,
    success_count: Number(row.success_count) || 0,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    total_tokens: Number(row.total_tokens) || 0,
    cached_tokens: Number(row.cached_tokens) || 0,
    cache_hit_count: Number(row.cache_hit_count) || 0,
    prompt_cache_hit_count: Number(row.prompt_cache_hit_count) || 0,
    tffb_sum: Number(row.tffb_sum) || 0,
    tffb_count: Number(row.tffb_count) || 0,
    response_time_sum: Number(row.response_time_sum) || 0,
    response_time_count: Number(row.response_time_count) || 0,
    speed_sum: Number(row.speed_sum) || 0,
    speed_count: Number(row.speed_count) || 0,
  };
}
