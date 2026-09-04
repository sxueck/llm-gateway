import request from "@/utils/request";

export interface ExpertTarget {
  id: string;
  category: string;
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
  description?: string;
  color?: string;
}

export interface ExpertTemplate {
  label: string;
  value: string;
  description: string;
  utterances: string[];
}

/** The external Intent Router API runs before this fallback classifier. */
export interface LlmSecondPassConfig {
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  timeout?: number;
  ignore_system_messages?: boolean;
  max_messages_to_classify?: number;
  ignored_tags?: string[];
  enable_structured_output?: boolean;
  enable_adaptive_thinking?: boolean;
}

/** Deprecated alias kept for transition; prefer LlmSecondPassConfig. */
export type ClassifierConfig = LlmSecondPassConfig;

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
  llm_second_pass: LlmSecondPassConfig;
  experts: ExpertTarget[];
  fallback?: FallbackConfig;
  session_binding_policy: SessionBindingPolicy;
}

export type PreprocessingConfig = NonNullable<
  ExpertRoutingConfig["preprocessing"]
>;

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
  llm_second_pass: LlmSecondPassConfig;
  // Editor always normalizes this; make it required to simplify v-model usage.
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
  fallback?: FallbackConfig;
  session_binding_policy?: SessionBindingPolicy;
  createVirtualModel?: boolean;
  virtualModelName?: string;
  modelAttributes?: any;
}

export interface UpdateExpertRoutingRequest {
  name?: string;
  description?: string;
  enabled?: boolean;
  llm_second_pass?: LlmSecondPassConfig;
  preprocessing?: ExpertRoutingConfig["preprocessing"];
  experts?: ExpertTarget[];
  fallback?: FallbackConfig;
  session_binding_policy?: SessionBindingPolicy;
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
}

export type TrainingRecordStatus = "pending_review" | "accepted" | "rejected";

export interface ExpertRoutingTrainingRecord {
  id: string;
  expert_routing_id: string;
  input_text: string;
  judge_intent_label: string;
  judge_confidence: number;
  judge_reason?: string;
  final_intent_label: string;
  final_expert_id?: string;
  status: TrainingRecordStatus;
  occurrence_count: number;
  created_at: number;
  updated_at: number;
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

  getTrainingRecords(
    id: string,
    status?: TrainingRecordStatus,
  ): Promise<{ records: ExpertRoutingTrainingRecord[] }> {
    return request.get(`/admin/expert-routing/${id}/training-records`, {
      params: status ? { status } : {},
    });
  },

  reviewTrainingRecord(
    id: string,
    recordId: string,
    data: Pick<ExpertRoutingTrainingRecord, "status" | "final_intent_label">,
  ): Promise<{ success: boolean }> {
    return request.patch(
      `/admin/expert-routing/${id}/training-records/${recordId}`,
      data,
    );
  },

  exportTrainingRecords(id: string): Promise<string> {
    return request.get(`/admin/expert-routing/${id}/training-records/export`, {
      headers: { Accept: "application/x-ndjson" },
      responseType: "text",
    });
  },
};
