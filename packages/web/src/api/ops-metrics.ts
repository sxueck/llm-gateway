import request from "@/utils/request";

export type OpsPeriod = "24h" | "7d" | "30d";

export type OpsDimension = "virtualKey" | "model" | "provider";

export interface OpsWindowInfo {
  startTime: number;
  endTime: number;
  timezone: string;
}

export interface OpsCoverage {
  detailStart: number;
  hourlyFrom: number | null;
  hourlyTo: number | null;
  gaps: Array<{ from: number; to: number }>;
  exact: boolean;
}

export interface OpsMetrics {
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

export interface OpsOverviewResponse {
  window: OpsWindowInfo;
  updatedAt: number;
  dataCoverage: OpsCoverage;
  metrics: OpsMetrics;
  tokenSemantics: {
    excludesCacheHitTokens: boolean;
  };
}

export interface OpsTrendPoint extends OpsMetrics {
  bucketStart: number;
  bucketEnd: number;
  partial: boolean;
  gap: boolean;
}

export interface OpsTrendResponse {
  window: OpsWindowInfo;
  updatedAt: number;
  granularity: "hour" | "day";
  dataCoverage: OpsCoverage;
  points: OpsTrendPoint[];
}

export interface OpsDimensionItem extends OpsMetrics {
  id: string | null;
  name: string;
  maskedKey: string | null;
}

export interface OpsDimensionListResponse {
  window: OpsWindowInfo;
  updatedAt: number;
  dimension: OpsDimension;
  dataCoverage: OpsCoverage;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  items: OpsDimensionItem[];
}

export interface OpsFilters {
  virtualKeyId?: string;
  model?: string;
  providerId?: string;
}

export interface OpsDimensionListParams extends OpsFilters {
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

const OPS_METRICS_PATH = "/admin/config/ops-metrics";

// Shared request params: the optional endTime pins the sampling instant so
// every call of one refresh cycle reports the identical [startTime, endTime).
export interface OpsQueryBase extends OpsFilters {
  period: OpsPeriod;
  endTime?: number;
}

// undefined params are dropped by the request layer
function toBaseParams(query: OpsQueryBase) {
  return {
    period: query.period,
    endTime: query.endTime,
    virtualKeyId: query.virtualKeyId,
    model: query.model,
    providerId: query.providerId,
  };
}

export const opsMetricsApi = {
  getOverview(query: OpsQueryBase): Promise<OpsOverviewResponse> {
    return request.get(`${OPS_METRICS_PATH}/overview`, {
      params: toBaseParams(query),
    });
  },

  getTrend(query: OpsQueryBase): Promise<OpsTrendResponse> {
    return request.get(`${OPS_METRICS_PATH}/trend`, {
      params: toBaseParams(query),
    });
  },

  getDimensionList(
    dimension: OpsDimension,
    query: OpsDimensionListParams & OpsQueryBase,
  ): Promise<OpsDimensionListResponse> {
    const params = {
      ...toBaseParams(query),
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      page: query.page,
      pageSize: query.pageSize,
    };
    return request.get(`${OPS_METRICS_PATH}/dimensions/${dimension}`, {
      params,
    });
  },
};
