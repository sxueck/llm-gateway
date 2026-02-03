export interface User {
  id: string;
  username: string;
}

export interface ProtocolMapping {
  openai?: string;
  anthropic?: string;
  google?: string;
}

export interface Provider {
  id: string;
  name: string;
  description?: string | null;
  baseUrl: string;
  protocolMappings?: ProtocolMapping | null;
  apiKey?: string;
  modelMapping?: Record<string, string> | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelAttributes {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_token_cache_hit?: number;

  litellm_provider?: string;
  provider?: string; // deprecated: alias of litellm_provider
  mode?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  requestTimeout?: number;
}

export interface Model {
  id: string;
  name: string;
  providerId: string;
  providerName?: string;
  modelIdentifier: string;
  protocol?: string | null; // 'openai' | 'anthropic' | 'google'
  isVirtual?: boolean;
  routingConfigId?: string | null;
  expertRoutingId?: string | null;
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
  disableLogging: boolean;
  dynamicCompressionEnabled: boolean;
  imageCompressionEnabled: boolean;
  interceptZeroTemperature: boolean;
  zeroTemperatureReplacement?: number | null;
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
  description?: string | null;
  baseUrl: string;
  protocolMappings?: ProtocolMapping;
  apiKey: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateProviderRequest {
  name?: string;
  description?: string | null;
  baseUrl?: string;
  protocolMappings?: ProtocolMapping;
  apiKey?: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
}

export interface CreateModelRequest {
  name: string;
  providerId: string;
  modelIdentifier: string;
  protocol?: string; // 'openai' | 'anthropic' | 'google'
  isVirtual?: boolean;
  routingConfigId?: string;
  enabled?: boolean;
  modelAttributes?: ModelAttributes;
}

export interface UpdateModelRequest {
  name?: string;
  modelIdentifier?: string;
  protocol?: string; // 'openai' | 'anthropic' | 'google'
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
  disableLogging?: boolean;
  dynamicCompressionEnabled?: boolean;
  imageCompressionEnabled?: boolean;
  interceptZeroTemperature?: boolean;
  zeroTemperatureReplacement?: number;
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
  disableLogging?: boolean;
  dynamicCompressionEnabled?: boolean;
  imageCompressionEnabled?: boolean;
  interceptZeroTemperature?: boolean;
  zeroTemperatureReplacement?: number;
}
