import request from "@/utils/request";

export interface ExpertTarget {
  /** Stable Jev choice key; do not change IDs of active session-bound candidates. */
  id: string;
  category: string;
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
  /** Criteria Jev uses to prefer this candidate. */
  description?: string;
  color?: string;
  /** Explicit price band override; otherwise inferred from blended token cost. */
  band?: Band;
}

/** Price band used by the router to bucket experts by blended cost. */
export type Band = "low" | "medium" | "high";

export interface ExpertTemplate {
  label: string;
  value: string;
  description: string;
  utterances: string[];
}

/** Minimum Jev choice probability required to route to a candidate expert. */
export const DEFAULT_CHOICE_THRESHOLD = 0.6;

/** Session binding TTL policy (NFR-4). */
export interface SessionBindingPolicy {
  idle_ttl_seconds: number;
  absolute_ttl_seconds: number;
}

export interface FallbackConfig {
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ExpertRoutingConfig {
  preprocessing?: {
    strip_tools?: boolean;
    strip_files?: boolean;
    strip_code_blocks?: boolean;
    strip_system_prompt?: boolean;
  };
  choice_threshold: number;
  /** Classifier dimension; defaults to expert on the backend. */
  classification_mode?: ClassificationMode;
  /** Failure policy when classification errors out; defaults to fallback. */
  fail_open?: FailOpenPolicy;
  experts: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_binding_policy: SessionBindingPolicy;
}

export type PreprocessingConfig = NonNullable<
  ExpertRoutingConfig["preprocessing"]
>;

export type ClassificationMode = "expert" | "difficulty";
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
  choice_threshold?: number;
  classification_mode?: ClassificationMode;
  fail_open?: FailOpenPolicy;
  // Editor always normalizes this; make it required to simplify v-model usage.
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_binding_policy?: SessionBindingPolicy;
  createVirtualModel?: boolean;
  virtualModelName?: string;
  modelAttributes?: any;
}

export interface UpdateExpertRoutingRequest {
  name?: string;
  description?: string;
  enabled?: boolean;
  choice_threshold?: number;
  classification_mode?: ClassificationMode;
  fail_open?: FailOpenPolicy;
  preprocessing?: ExpertRoutingConfig["preprocessing"];
  experts?: ExpertTarget[];
  fallback?: FallbackConfig | null;
  session_binding_policy?: SessionBindingPolicy;
}

/** One row of a band preview (shape of backend computeBandPreview entries). */
export interface BandPreviewEntry {
  id: string;
  category: string;
  type: "virtual" | "real";
  /** Explicit band override, null when inferred from cost. */
  explicitBand: Band | null;
  /** Blended per-token price; null/Infinity when cost info is unknown. */
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
  categoryDistribution: Record<string, number>;
  routeSourceDistribution?: Record<string, number>;
  cleaningStats?: {
    avgPromptTokens: number;
    avgCleanedLength: number;
    totalRequests: number;
  };
  /** PR-3 v47 observation; empty when no persisted rows exist. */
  difficultyDistribution?: Record<string, number>;
  bandDistribution?: Record<string, number>;
  /** Share of fallback fail-open requests; null when not computable. */
  failOpenRate?: number | null;
  /** Always null today: no actual usage tokens / full price mapping persisted. */
  estimatedSavingVsHighBand?: number | null;
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
  semantic_score?: number;
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
  semantic_score?: number;
  difficulty?: string | null;
  band?: string | null;
  verdict_reused?: number;
  classifier_time_ms?: number | null;
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

  getLogsByCategory(
    id: string,
    category: string,
    limit?: number,
  ): Promise<{ logs: ExpertRoutingLog[] }> {
    const params = limit ? { limit: limit.toString() } : {};
    return request.get(
      `/admin/expert-routing/${id}/logs/category/${encodeURIComponent(category)}`,
      { params },
    );
  },

  getLogDetails(id: string, logId: string): Promise<ExpertRoutingLogDetail> {
    return request.get(`/admin/expert-routing/${id}/logs/${logId}/details`);
  },

  associateModels(
    id: string,
    modelIds: string[],
  ): Promise<{ success: boolean }> {
    return request.post(`/admin/expert-routing/${id}/models`, { modelIds });
  },

  disassociateModel(
    id: string,
    modelId: string,
  ): Promise<{ success: boolean }> {
    return request.delete(`/admin/expert-routing/${id}/models/${modelId}`);
  },

  savePreviewWidth(width: number): Promise<{ success: boolean }> {
    return request.post("/admin/expert-routing/preferences/preview-width", {
      width,
    });
  },

  getPreviewWidth(): Promise<{ width: number }> {
    return request.get("/admin/expert-routing/preferences/preview-width");
  },

  getTemplates(): Promise<{ templates: ExpertTemplate[] }> {
    return request.get("/admin/expert-routing/templates");
  },

  /** Band preview of the saved configuration. */
  getBandPreview(id: string): Promise<BandPreviewResponse> {
    return request.get(`/admin/expert-routing/${id}/bands/preview`);
  },

  previewBands(
    id: string | null | undefined,
    experts: ExpertTarget[],
  ): Promise<BandPreviewResponse> {
    const path = id
      ? `/admin/expert-routing/${id}/bands/preview`
      : "/admin/expert-routing/bands/preview";
    return request.post(path, { experts });
  },

};
