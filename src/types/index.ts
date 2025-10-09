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

