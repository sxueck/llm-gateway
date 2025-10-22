export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model_mapping: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface VirtualKey {
  id: string;
  key_value: string;
  key_hash: string;
  name: string;
  provider_id: string | null;
  model_id: string | null;
  routing_strategy: string;
  model_ids: string | null;
  routing_config: string | null;
  enabled: number;
  rate_limit: number | null;
  cache_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface SystemConfig {
  key: string;
  value: string;
  description: string | null;
  updated_at: number;
}

export interface ModelAttributes {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_token_cache_hit?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_tool_choice?: boolean;
  supports_assistant_prefill?: boolean;
  supports_prompt_caching?: boolean;
  supports_reasoning?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  litellm_provider?: string;
  mode?: string;
}

export interface PortkeyConfig {
  credentials: {
    [providerId: string]: {
      provider?: string;
      api_key: string;
      base_url?: string;
    };
  };
  virtual_keys: {
    [keyValue: string]: {
      provider: string;
      override_params?: Record<string, any>;
    };
  };
}

export interface PortkeyGateway {
  id: string;
  name: string;
  url: string;
  description: string | null;
  is_default: number;
  enabled: number;
  container_name: string | null;
  port: number | null;
  api_key: string | null;
  install_status: string | null;
  last_heartbeat: number | null;
  agent_version: string | null;
  created_at: number;
  updated_at: number;
}

export interface ModelRoutingRule {
  id: string;
  name: string;
  description: string | null;
  portkey_gateway_id: string;
  rule_type: 'model_name' | 'provider' | 'region' | 'pattern';
  rule_value: string;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface PromptConfig {
  operationType: 'replace' | 'prepend' | 'system';
  templateContent: string;
  systemMessage?: string;
  enabled: boolean;
  injectOnce?: boolean;
}

export interface ExpertRoutingConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  classifier: {
    type: 'virtual' | 'real';
    model_id?: string;
    provider_id?: string;
    model?: string;
    prompt_template: string;
    max_tokens?: number;
    temperature?: number;
    timeout?: number;
    ignore_system_messages?: boolean;
    max_messages_to_classify?: number;
  };
  experts: ExpertTarget[];
  fallback?: {
    type: 'virtual' | 'real';
    model_id?: string;
    provider_id?: string;
    model?: string;
  };
}

export interface ExpertTarget {
  id: string;
  category: string;
  type: 'virtual' | 'real';
  model_id?: string;
  provider_id?: string;
  model?: string;
  description?: string;
  color?: string;
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
}

