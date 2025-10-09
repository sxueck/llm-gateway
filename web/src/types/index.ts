export interface User {
  id: string;
  username: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelMapping?: Record<string, string> | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

export interface Model {
  id: string;
  name: string;
  providerId: string;
  providerName?: string;
  modelIdentifier: string;
  isVirtual?: boolean;
  routingConfigId?: string | null;
  enabled: boolean;
  modelAttributes?: ModelAttributes | null;
  virtualKeyCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface VirtualKey {
  id: string;
  keyValue: string;
  name: string;
  providerId?: string | null;
  modelId?: string | null;
  routingStrategy?: string;
  modelIds?: string[] | null;
  routingConfig?: RoutingConfig | null;
  enabled: boolean;
  rateLimit?: number | null;
  cacheEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutingConfig {
  algorithm?: 'round-robin' | 'random' | 'weighted';
  weights?: Record<string, number>;
  failoverPriority?: string[];
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface CreateProviderRequest {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateProviderRequest {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
}

export interface CreateModelRequest {
  name: string;
  providerId: string;
  modelIdentifier: string;
  isVirtual?: boolean;
  routingConfigId?: string;
  enabled?: boolean;
  modelAttributes?: ModelAttributes;
}

export interface UpdateModelRequest {
  name?: string;
  modelIdentifier?: string;
  enabled?: boolean;
  modelAttributes?: ModelAttributes;
}

export interface CreateVirtualKeyRequest {
  name: string;
  providerId?: string;
  modelId?: string;
  routingStrategy?: 'single' | 'load-balance' | 'failover';
  modelIds?: string[];
  routingConfig?: RoutingConfig;
  keyType: 'auto' | 'custom';
  customKey?: string;
  rateLimit?: number;
  enabled?: boolean;
  cacheEnabled?: boolean;
}

export interface UpdateVirtualKeyRequest {
  name?: string;
  providerId?: string;
  modelId?: string;
  routingStrategy?: string;
  modelIds?: string[];
  routingConfig?: RoutingConfig;
  enabled?: boolean;
  rateLimit?: number;
  cacheEnabled?: boolean;
}

