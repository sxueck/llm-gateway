export interface Model {
  id: string;
  name: string;
  provider_id: string | null;
  model_identifier: string;
  protocol: string | null; // 'openai' | 'anthropic' | 'google' - 模型级别的协议声明
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

export interface HealthTarget {
  id: string;
  name: string;
  type: 'model' | 'virtual_model';
  target_id: string;
  enabled: number;
  check_interval_seconds: number;
  check_prompt: string | null;
  check_config: string | null;
  created_at: number;
  updated_at: number;
}

export interface HealthRun {
  id: string;
  target_id: string;
  status: 'success' | 'error';
  latency_ms: number;
  error_type: string | null;
  error_message: string | null;
  request_id: string | null;
  created_at: number;
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
  error_message?: string;
  request_body?: string;
  response_body?: string;
  cache_hit?: number;
  request_type?: string;
  compression_original_tokens?: number;
  compression_saved_tokens?: number;
};
