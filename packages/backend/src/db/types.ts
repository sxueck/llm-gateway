export interface Model {
  id: string;
  name: string;
  provider_id: string | null;
  model_identifier: string;
  supported_protocols: string | null; // JSON array of 'openai' | 'anthropic' | 'google' - 模型支持的协议白名单
  is_virtual: number;
  routing_config_id: string | null;
  expert_routing_id?: string | null;
  enabled: number;
  model_attributes: string | null;
  prompt_config: string | null;
  compression_config: string | null;
  created_at: number;
  updated_at: number;
}

export interface CostMapping {
  id: string;
  pattern: string;
  target_model: string;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export type ApiRequestBuffer = {
  id: string;
  virtual_key_id?: string;
  provider_id?: string;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  status: string;
  response_time?: number;
  tffb_ms?: number;
  error_message?: string;
  request_body?: string;
  response_body?: string;
  request_params_json?: string;
  response_meta_json?: string;
  cache_hit?: number;
  request_type?: string;
  compression_original_tokens?: number;
  compression_saved_tokens?: number;
  ip?: string;
  user_agent?: string;
  /** agent run 关联（loopback 打标，仅内部可信来源写入） */
  run_id?: string;
};

export interface RepositorySnapshot {
  id: string;
  user_id: string;
  virtual_key_id: string | null;
  source_type: string;
  display_name: string | null;
  git_remote: string | null;
  head_commit: string | null;
  manifest_encrypted: string;
  dek_encrypted: string;
  file_count: number;
  total_size: number;
  storage_prefix: string;
  status: "uploading" | "ready" | "deleted";
  created_at: number;
  expires_at: number;
  deleted_at: number | null;
}

export interface AgentSearchRun {
  id: string;
  user_id: string;
  virtual_key_id: string | null;
  plugin_id: string;
  plugin_version: string;
  plugin_digest: string;
  source_type: "snapshot" | "public_git";
  snapshot_id: string | null;
  public_git_url_encrypted: string | null;
  requested_ref: string | null;
  resolved_commit: string | null;
  query_encrypted: string;
  model_profile: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "budget_exceeded"
    | "expired";
  result_encrypted: string | null;
  error_code: string | null;
  error_message: string | null;
  service_token_hash: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  expires_at: number;
  cancellation_requested_at: number | null;
}

export interface AgentSearchUsage {
  run_id: string;
  turn_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  model_route_metadata: string | null;
  updated_at: number;
}

export interface AgentSearchRunEventRow {
  id: number;
  run_id: string;
  seq: number;
  type: string;
  payload_json: string | null;
  created_at: number;
}

export interface WorkerPluginRow {
  id: string;
  version: string;
  digest: string;
  name: string;
  description: string | null;
  manifest_json: string;
  bundle_files_json: string;
  changelog: string | null;
  bundle_url: string | null;
  signature: string | null;
  status: 'draft' | 'published' | 'deprecated' | 'revoked';
  published_at: number | null;
  deprecated_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface UserPluginEnrollmentRow {
  user_id: string;
  plugin_id: string;
  version: string;
  enabled: number;
  is_default: number;
  updated_at: number;
}
