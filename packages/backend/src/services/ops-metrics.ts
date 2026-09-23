import {
  opsMetricsRepository,
  type OpsFilters,
  type OpsDimension,
  type SegmentRange,
  type SegmentTotalsRow,
} from "../db/repositories/ops-metrics.repository.js";
import { apiRequestHourlyDb } from "../db/index.js";
import { appConfig } from "../config/index.js";
import {
  getShanghaiDayStart,
  generateShanghaiDayBuckets,
} from "../db/utils/time-buckets.js";

/**
 * Ops-monitoring shared aggregation service. One window resolution, one
 * metric convention and one segment split feed the ops page AND the homepage
 * rolling windows, so identical filters always produce identical numbers.
 *
 * Window: half-open [startTime, endTime), endTime fixed once per refresh.
 * Segments (provability-ordered):
 * - sealed hourly aggregates for interior full hours;
 * - raw detail for boundary partial hours and the unsealed tail;
 * - anything below detail retention with no hourly coverage is an explicit
 *   coverage gap, never an approximation.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type OpsPeriod = "24h" | "7d" | "30d";

const PERIOD_MS: Record<OpsPeriod, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function isOpsPeriod(value: unknown): value is OpsPeriod {
  return value === "24h" || value === "7d" || value === "30d";
}

export interface OpsWindow {
  period: OpsPeriod;
  startTime: number;
  endTime: number;
}

export function resolveWindow(
  period: OpsPeriod,
  endTime: number = Date.now(),
): OpsWindow {
  return { period, endTime, startTime: endTime - PERIOD_MS[period] };
}

function ceilHour(ts: number): number {
  return Math.ceil(ts / HOUR_MS) * HOUR_MS;
}

function floorHour(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

export interface OpsCoverage {
  detailStart: number;
  hourlyFrom: number | null;
  hourlyTo: number | null;
  gaps: { from: number; to: number }[];
  /** True when the whole window is provably covered (hourly + detail). */
  exact: boolean;
}

interface SegmentPlan {
  hourlyRange: SegmentRange | null;
  detailRanges: SegmentRange[];
  coverage: OpsCoverage;
}

async function planSegments(
  window: OpsWindow,
  coverageBounds?: {
    firstBucket: number | null;
    lastBucketEnd: number | null;
  },
): Promise<SegmentPlan> {
  const detailStart = getShanghaiDayStart(
    -appConfig.apiRequestLogRetentionDays,
  );
  const bounds =
    coverageBounds ?? (await apiRequestHourlyDb.getCoverageBounds());

  const hourlyFrom =
    bounds.firstBucket !== null && bounds.lastBucketEnd !== null
      ? Math.max(ceilHour(window.startTime), bounds.firstBucket)
      : null;
  const hourlyTo =
    hourlyFrom !== null
      ? Math.min(window.endTime, bounds.lastBucketEnd as number)
      : null;
  const hourlyRange: SegmentRange | null =
    hourlyFrom !== null && hourlyTo !== null && hourlyTo > hourlyFrom
      ? { from: hourlyFrom, to: hourlyTo }
      : null;

  // Detail covers everything outside the hourly region, clamped to retained
  // detail; spans below detailStart are gaps, not approximations.
  const detailRanges: SegmentRange[] = [];
  const gaps: { from: number; to: number }[] = [];
  const headEnd = hourlyRange ? hourlyRange.from : window.endTime;
  const tailStart = hourlyRange ? hourlyRange.to : window.endTime;

  if (window.startTime < headEnd) {
    const detailFrom = Math.max(window.startTime, detailStart);
    if (detailFrom > window.startTime) {
      gaps.push({ from: window.startTime, to: Math.min(detailFrom, headEnd) });
    }
    if (detailFrom < headEnd) {
      detailRanges.push({ from: detailFrom, to: headEnd });
    }
  }
  if (tailStart < window.endTime) {
    const detailFrom = Math.max(tailStart, detailStart);
    if (detailFrom > tailStart) {
      gaps.push({ from: tailStart, to: Math.min(detailFrom, window.endTime) });
    }
    if (detailFrom < window.endTime) {
      detailRanges.push({ from: detailFrom, to: window.endTime });
    }
  }

  return {
    hourlyRange,
    detailRanges,
    coverage: {
      detailStart,
      hourlyFrom: hourlyRange ? hourlyRange.from : null,
      hourlyTo: hourlyRange ? hourlyRange.to : null,
      gaps: gaps.filter((g) => g.to > g.from),
      exact: gaps.length === 0,
    },
  };
}

function mergeSegmentTotals(
  rows: (SegmentTotalsRow | null)[],
): SegmentTotalsRow | null {
  const valid = rows.filter((r): r is SegmentTotalsRow => r !== null);
  if (valid.length === 0) return null;
  // Number() coercion is mandatory: mysql2 returns SUM()/MAX() aggregates as
  // strings, and naive + would concatenate (4 + 1 -> "41").
  const num = (v: unknown) => Number(v) || 0;
  return valid.reduce((acc, row) => ({
    request_count: num(acc.request_count) + num(row.request_count),
    success_count: num(acc.success_count) + num(row.success_count),
    prompt_tokens: num(acc.prompt_tokens) + num(row.prompt_tokens),
    completion_tokens: num(acc.completion_tokens) + num(row.completion_tokens),
    total_tokens: num(acc.total_tokens) + num(row.total_tokens),
    cached_tokens: num(acc.cached_tokens) + num(row.cached_tokens),
    cache_hit_count: num(acc.cache_hit_count) + num(row.cache_hit_count),
    prompt_cache_hit_count:
      num(acc.prompt_cache_hit_count) + num(row.prompt_cache_hit_count),
    tffb_sum: num(acc.tffb_sum) + num(row.tffb_sum),
    tffb_count: num(acc.tffb_count) + num(row.tffb_count),
    response_time_sum: num(acc.response_time_sum) + num(row.response_time_sum),
    response_time_count:
      num(acc.response_time_count) + num(row.response_time_count),
    speed_sum: num(acc.speed_sum) + num(row.speed_sum),
    speed_count: num(acc.speed_count) + num(row.speed_count),
    last_used_at:
      acc.last_used_at && row.last_used_at
        ? Math.max(Number(acc.last_used_at), Number(row.last_used_at))
        : Number(acc.last_used_at ?? row.last_used_at ?? 0) || null,
  }));
}

function toMetricTotals(row: SegmentTotalsRow | null) {
  const requestCount = row ? Number(row.request_count) : 0;
  const successCount = row ? Number(row.success_count) : 0;
  const tffbCount = row ? Number(row.tffb_count) : 0;
  const responseTimeCount = row ? Number(row.response_time_count) : 0;
  const speedCount = row ? Number(row.speed_count) : 0;
  const lastUsedAt = row && row.last_used_at ? Number(row.last_used_at) : null;
  return {
    requestCount,
    successCount,
    failureCount: requestCount - successCount,
    successRate: requestCount > 0 ? successCount / requestCount : null,
    promptTokens: row ? Number(row.prompt_tokens) : 0,
    completionTokens: row ? Number(row.completion_tokens) : 0,
    totalTokens: row ? Number(row.total_tokens) : 0,
    cachedTokens: row ? Number(row.cached_tokens) : 0,
    cacheHitCount: row ? Number(row.cache_hit_count) : 0,
    promptCacheHitCount: row ? Number(row.prompt_cache_hit_count) : 0,
    avgTffbMs: tffbCount > 0 ? Number(row?.tffb_sum) / tffbCount : null,
    validTffbCount: tffbCount,
    avgResponseTimeMs:
      responseTimeCount > 0
        ? Number(row?.response_time_sum) / responseTimeCount
        : null,
    validResponseTimeCount: responseTimeCount,
    avgOutputSpeed: speedCount > 0 ? Number(row?.speed_sum) / speedCount : null,
    validSpeedCount: speedCount,
    lastUsedAt: lastUsedAt && lastUsedAt > 0 ? lastUsedAt : null,
  };
}

export async function getOpsOverview(window: OpsWindow, filters: OpsFilters) {
  const plan = await planSegments(window);
  const hourlyTotals = plan.hourlyRange
    ? await opsMetricsRepository.getHourlyTotals(plan.hourlyRange, filters)
    : null;
  const detailTotals = await Promise.all(
    plan.detailRanges.map((r) =>
      opsMetricsRepository.getDetailTotals(r, filters),
    ),
  );
  const totals = mergeSegmentTotals([hourlyTotals, ...detailTotals]);

  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    dataCoverage: plan.coverage,
    metrics: toMetricTotals(totals),
    // Tokens exclude cache-hit responses (served from the gateway's own
    // response cache); cached_tokens reports prompt-cache reads separately.
    tokenSemantics: {
      excludesCacheHitTokens: true,
    },
  };
}

export interface OpsTrendPoint {
  bucketStart: number;
  bucketEnd: number;
  partial: boolean;
  gap: boolean;
  requestCount: number | null;
  successCount: number | null;
  failureCount: number | null;
  successRate: number | null;
  totalTokens: number | null;
  avgTffbMs: number | null;
  avgResponseTimeMs: number | null;
  avgOutputSpeed: number | null;
}

export async function getOpsTrend(window: OpsWindow, filters: OpsFilters) {
  const plan = await planSegments(window);
  const byHour = window.period === "24h";

  interface TrendBucket {
    bucketStart: number;
    bucketEnd: number;
    partial: boolean;
  }
  const points: TrendBucket[] = [];
  if (byHour) {
    for (
      let b = floorHour(window.startTime);
      b < window.endTime;
      b += HOUR_MS
    ) {
      points.push({
        bucketStart: b,
        bucketEnd: b + HOUR_MS,
        partial: b < window.startTime || b + HOUR_MS > window.endTime,
      });
    }
  } else {
    for (const dayStart of generateShanghaiDayBuckets(
      window.startTime,
      window.endTime - 1,
    )) {
      points.push({
        bucketStart: dayStart,
        bucketEnd: dayStart + DAY_MS,
        partial:
          dayStart < window.startTime || dayStart + DAY_MS > window.endTime,
      });
    }
  }

  // Same segment split as the overview: the hourly region and the detail
  // ranges are disjoint by construction, so grouped per-bucket reads from the
  // two sides can be merged per bucket without ever double-counting.
  const detailStart = plan.coverage.detailStart;
  const floorMs = byHour ? HOUR_MS : DAY_MS;
  const offsetMs = byHour ? 0 : SHANGHAI_OFFSET_MS;

  const detailGrouped =
    plan.detailRanges.length > 0
      ? await opsMetricsRepository.getDetailTotalsGroupedByBucket(
          plan.detailRanges,
          floorMs,
          offsetMs,
          filters,
        )
      : new Map<number, SegmentTotalsRow>();
  const hourlyGrouped = plan.hourlyRange
    ? await opsMetricsRepository.getHourlyTotalsGroupedByBucket(
        plan.hourlyRange,
        floorMs,
        offsetMs,
        filters,
      )
    : new Map<number, SegmentTotalsRow>();

  const inHourlyRegion = (point: { bucketStart: number; bucketEnd: number }) =>
    plan.hourlyRange !== null &&
    point.bucketStart >= plan.hourlyRange.from &&
    point.bucketEnd <= plan.hourlyRange.to;

  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    granularity: byHour ? "hour" : "day",
    dataCoverage: plan.coverage,
    points: points.map((point) => {
      const inGap = !inHourlyRegion(point) && point.bucketEnd <= detailStart;
      const row = mergeSegmentTotals([
        hourlyGrouped.get(point.bucketStart) ?? null,
        detailGrouped.get(point.bucketStart) ?? null,
      ]);
      const metrics = row
        ? toMetricTotals(row)
        : {
            requestCount: null,
            successCount: null,
            failureCount: null,
            successRate: null,
            totalTokens: null,
            avgTffbMs: null,
            avgResponseTimeMs: null,
            avgOutputSpeed: null,
          };
      return {
        bucketStart: point.bucketStart,
        bucketEnd: point.bucketEnd,
        partial: point.partial,
        gap: inGap,
        ...metrics,
      };
    }),
  };
}

export interface OpsDimensionQuery {
  dimension: OpsDimension;
  filters: OpsFilters;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

const DIMENSION_LIMIT = 2000;

const SORT_FIELD_WHITELIST = new Set([
  "requestCount",
  "successCount",
  "failureCount",
  "successRate",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "cachedTokens",
  "avgTffbMs",
  "avgResponseTimeMs",
  "avgOutputSpeed",
  "lastUsedAt",
]);

interface DimensionItem {
  id: string | null;
  name: string;
  maskedKey: string | null;
  requestCount: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitCount: number;
  promptCacheHitCount: number;
  avgTffbMs: number | null;
  validTffbCount: number;
  avgResponseTimeMs: number | null;
  validResponseTimeCount: number;
  avgOutputSpeed: number | null;
  validSpeedCount: number;
  lastUsedAt: number | null;
}

function resolveDimensionDisplayName(
  entry: { dimensionKey: string; displayName: string | null },
  dimension: OpsDimension,
): string {
  if (entry.displayName) return entry.displayName;
  if (entry.dimensionKey === "") return "未知";
  if (dimension === "virtualKey") return `已删除密钥 (${entry.dimensionKey})`;
  return entry.dimensionKey;
}

export async function getOpsDimensionList(
  window: OpsWindow,
  query: OpsDimensionQuery,
) {
  const plan = await planSegments(window);
  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
  const page = Math.max(query.page ?? 1, 1);

  const segmentInputs: { kind: "detail" | "hourly"; range: SegmentRange }[] = [
    ...plan.detailRanges.map((range) => ({ kind: "detail" as const, range })),
    ...(plan.hourlyRange
      ? [{ kind: "hourly" as const, range: plan.hourlyRange }]
      : []),
  ];

  const merged = new Map<
    string,
    {
      dimensionKey: string;
      displayName: string | null;
      maskedKey: string | null;
      row: SegmentTotalsRow;
    }
  >();
  for (const segment of segmentInputs) {
    const rows = await opsMetricsRepository.getDimensionTotals(
      segment,
      query.dimension,
      query.filters,
      query.search,
      DIMENSION_LIMIT,
    );
    for (const row of rows) {
      const key = String(row.dimension_key);
      const existing = merged.get(key);
      const displayName = row.display_name ?? existing?.displayName ?? null;
      const maskedKey = row.masked_key ?? existing?.maskedKey ?? null;
      if (existing) {
        existing.row = mergeSegmentTotals([existing.row, row]) ?? existing.row;
        existing.displayName = displayName;
        existing.maskedKey = maskedKey;
      } else {
        merged.set(key, {
          dimensionKey: key,
          displayName,
          maskedKey,
          row,
        });
      }
    }
  }

  const items = [...merged.values()].map((entry) => ({
    id: entry.dimensionKey === "" ? null : entry.dimensionKey,
    name: resolveDimensionDisplayName(entry, query.dimension),
    maskedKey: entry.maskedKey ?? null,
    ...toMetricTotals(entry.row),
  }));

  const sortBy = SORT_FIELD_WHITELIST.has(query.sortBy ?? "")
    ? (query.sortBy as keyof DimensionItem)
    : "requestCount";
  const direction = query.sortOrder === "asc" ? 1 : -1;
  items.sort((a, b) => {
    const av: unknown = a[sortBy as keyof DimensionItem];
    const bv: unknown = b[sortBy as keyof DimensionItem];
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // null values sink regardless of direction
    if (bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * direction;
    }
    return (Number(av) - Number(bv)) * direction;
  });

  const total = items.length;
  const start = (page - 1) * pageSize;

  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    dimension: query.dimension,
    dataCoverage: plan.coverage,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    },
    items: items.slice(start, start + pageSize),
  };
}
