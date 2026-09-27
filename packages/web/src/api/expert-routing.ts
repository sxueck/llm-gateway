import request from "@/utils/request";

/** v2: candidate in a difficulty-tiered routing config. */
export interface ExpertTarget {
  /** Stable key; session bindings reference it — never rename live candidates. */
  id: string;
  /** Mandatory tier; array order decides priority within the tier. */
  band: Band;
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
}

/** Difficulty tier used to bucket candidates. */
export type Band = "low" | "medium" | "high";

export type SessionPolicyMode = "per_turn" | "sticky" | "escalate_only";

/** v2 session policy (PRD §5.1). */
export interface SessionPolicy {
  mode: SessionPolicyMode;
  idle_ttl_seconds: number;
  absolute_ttl_seconds: number;
}

export interface ClassifierConfig {
  timeout_ms?: number;
  on_low_confidence?: "escalate" | "keep";
  min_confidence?: number;
}

/** How routing facts are exposed to clients (PRD §4). */
export interface ExposureConfig {
  headers?: boolean;
  provider_header?: boolean;
  model_field?: "upstream" | "gateway_name";
  sse_comment?: boolean;
}

export interface FallbackConfig {
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ExpertRoutingConfig {
  version?: 2;
  preprocessing?: {
    strip_tools?: boolean;
    strip_files?: boolean;
    strip_code_blocks?: boolean;
    strip_system_prompt?: boolean;
  };
  /** Failure policy when classification errors out; defaults to fallback. */
  fail_open?: FailOpenPolicy;
  experts: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_policy: SessionPolicy;
  classifier?: ClassifierConfig;
  exposure?: ExposureConfig;
}

export type PreprocessingConfig = NonNullable<
  ExpertRoutingConfig["preprocessing"]
>;

export type FailOpenPolicy = "fallback" | "parent" | "error";

export interface ExpertRouting {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  config: ExpertRoutingConfig;
  createdAt: number;
  updatedAt: number;
  virtualModel?: {
    id: string;
    name: string;
    providerId: string | null;
    modelIdentifier: string;
    isVirtual: boolean;
    expertRoutingId: string | null;
  } | null;
}

export interface CreateExpertRoutingRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  fail_open?: FailOpenPolicy;
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_policy?: SessionPolicy;
  classifier?: ClassifierConfig;
  exposure?: ExposureConfig;
  createVirtualModel?: boolean;
  virtualModelName?: string;
  modelAttributes?: any;
}

export interface UpdateExpertRoutingRequest {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  fail_open?: FailOpenPolicy;
  preprocessing?: ExpertRoutingConfig["preprocessing"];
  experts?: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_policy?: SessionPolicy;
  classifier?: ClassifierConfig;
  exposure?: ExposureConfig;
}

/** One row of a band preview (shape of backend computeBandPreview entries). */
export interface BandPreviewEntry {
  id: string;
  type: "virtual" | "real";
  /** Explicit band, null when inferred from cost. */
  explicitBand: Band | null;
  /** Blended per-token price; Infinity when cost info is unknown. */
  blendedPrice: number | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
}

export interface BandPreviewResponse {
  bands: Record<Band, BandPreviewEntry[]>;
  /** expert id -> assigned band. */
  assignment: Record<string, Band>;
}

export interface ExpertRoutingStatistics {
  totalRequests: number;
  avgClassificationTime: number;
  classifierLatency?: {
    count: number;
    p50: number | null;
    p95: number | null;
    avg: number | null;
  };
  routeSourceDistribution?: Record<string, number>;
  cleaningStats?: {
    avgPromptTokens: number;
    avgCleanedLength: number;
    totalRequests: number;
  };
  difficultyDistribution?: Record<string, number>;
  bandDistribution?: Record<string, number>;
  failOpenRate?: number | null;
  /** §5.8: computed from actual api_requests tokens linked via route_log_id;
   * null when no priced high-tier expert exists to baseline against. */
  estimatedSavingVsHighBand?: {
    actualCost: number;
    baselineCost: number;
    saving: number;
    savingPct: number | null;
    linkedRequests: number;
    cacheHitTokens: number;
  } | null;
  limitations?: string[];
}

export interface ExpertRoutingLog {
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
  created_at: number;
  route_source?: string;
  prompt_tokens?: number;
  cleaned_content_length?: number;
  difficulty?: string | null;
  band?: string | null;
  verdict_reused?: number;
  classifier_time_ms?: number | null;
}

export interface ExpertRoutingLogDetail {
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
  created_at: number;
  original_request: any[] | null;
  classifier_request: any | null;
  classifier_response: any | null;
  route_source?: string;
  prompt_tokens?: number;
  cleaned_content_length?: number;
  difficulty?: string | null;
  band?: string | null;
  verdict_reused?: number;
  classifier_time_ms?: number | null;
}

/** §3.3 RoutingSimulator response. */
export interface RoutingSimulation {
  intentText: string;
  stats?: {
    promptTokens?: number;
    cleanedLength?: number;
    originalTokens?: number;
    cleanedTokens?: number;
  };
  difficulty: "low" | "medium" | "high";
  confidence: number;
  ranked: Array<{ expertId: string; probability: number }>;
  classifierModel: string;
  classifierTimeMs: number;
  band: Band;
  candidates: Array<{ id: string; band: Band; type: "virtual" | "real" }>;
  wouldHit: string | null;
}

/** §5.5 classifier runtime status. */
export interface JevStatus {
  configured: boolean;
  model: string | null;
  breaker: {
    open: boolean;
    openUntil: number | null;
    consecutiveFailures: number;
    lastError: string | null;
  };
}

export const expertRoutingApi = {
  getAll(): Promise<{ configs: ExpertRouting[] }> {
    return request.get("/admin/expert-routing");
  },

  getById(id: string): Promise<ExpertRouting> {
    return request.get(`/admin/expert-routing/${id}`);
  },

  create(data: CreateExpertRoutingRequest): Promise<ExpertRouting> {
    return request.post("/admin/expert-routing", data);
  },

  update(id: string, data: UpdateExpertRoutingRequest): Promise<ExpertRouting> {
    return request.put(`/admin/expert-routing/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/expert-routing/${id}`);
  },

  getStatistics(
    id: string,
    timeRange?: number,
  ): Promise<ExpertRoutingStatistics> {
    const params = timeRange ? { timeRange: timeRange.toString() } : {};
    return request.get(`/admin/expert-routing/${id}/statistics`, { params });
  },

  getLogs(id: string, limit?: number): Promise<{ logs: ExpertRoutingLog[] }> {
    const params = limit ? { limit: limit.toString() } : {};
    return request.get(`/admin/expert-routing/${id}/logs`, { params });
  },

  getLogDetails(id: string, logId: string): Promise<ExpertRoutingLogDetail> {
    return request.get(`/admin/expert-routing/${id}/logs/${logId}/details`);
  },

  getJevStatus(): Promise<JevStatus> {
    return request.get("/admin/expert-routing/jev/status");
  },

  /** Simulate a prompt against an unsaved draft config (no side effects). */
  simulate(
    config: { experts: ExpertTarget[]; preprocessing?: PreprocessingConfig },
    input: { prompt?: string; messages?: any[] },
  ): Promise<RoutingSimulation> {
    return request.post("/admin/expert-routing/simulate", {
      ...input,
      config,
    });
  },

  /** Simulate a prompt against a saved config (no side effects). */
  simulateById(
    id: string,
    input: { prompt?: string; messages?: any[] },
  ): Promise<RoutingSimulation> {
    return request.post(`/admin/expert-routing/${encodeURIComponent(id)}/simulate`, input);
  },

  getBandPreview(id: string): Promise<BandPreviewResponse> {
    return request.get(`/admin/expert-routing/${id}/bands/preview`);
  },

  previewBands(
    id: string | null | undefined,
    experts: Array<Omit<ExpertTarget, "band"> & { band?: Band }>,
  ): Promise<BandPreviewResponse> {
    const path = id
      ? `/admin/expert-routing/${id}/bands/preview`
      : "/admin/expert-routing/bands/preview";
    return request.post(path, { experts });
  },
};
