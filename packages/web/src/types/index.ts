import type { VirtualKeyRoutingStrategy } from "@llm-gateway/shared";

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

  max_tokens?: number;
  max_completion_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_length?: number;
  context_window?: number;
  limit?: number;
  supports_vision?: boolean;
  supports_prompt_caching?: boolean;
  supports_function_calling?: boolean;

  upstream_websocket_enabled?: boolean;

  disable_thinking?: boolean;

  litellm_provider?: string;
  provider?: string; // deprecated: alias of litellm_provider
  mode?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  requestTimeout?: number;
}

export interface ModelAvailabilityBucket {
  start: number;
  total: number;
  success: number;
}

export interface ModelAvailability {
  windowHours: number;
  total: number;
  success: number;
  lastUsedAt: number;
  buckets: ModelAvailabilityBucket[];
}

export interface Model {
  id: string;
  name: string;
  providerId: string;
  providerName?: string;
  modelIdentifier: string;
  /** 由供应商派生的可用协议（base_url→openai + protocol_mappings） */
  supportedProtocols?: string[];
  isVirtual?: boolean;
  routingConfigId?: string | null;
  expertRoutingId?: string | null;
  enabled: boolean;
  modelAttributes?: ModelAttributes | null;
  virtualKeyCount?: number;
  /** 被动可用性（近24h api_requests 聚合）；无调用记录时为 null */
  availability?: ModelAvailability | null;
  createdAt: number;
  updatedAt: number;
}

export interface VirtualKey {
  id: string;
  // Masked by the backend in list/get responses; plaintext arrives only once,
  // in the top-level keyValue of create/rotate responses.
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
  /** 上下文预算档位 tokens（200K/400K/600K/800K），null=关闭 */
  contextBudgetTokens: number | null;
  imageCompressionEnabled: boolean;
  interceptZeroTemperature: boolean;
  zeroTemperatureReplacement?: number | null;
  piiProtectionEnabled: boolean;
  /** 后端自 db 行映射返回；类型上保持可选，未返回时展示为未知而非默认值 */
  contextNormalizationEnabled?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RoutingConfig {
  algorithm?: "round-robin" | "random" | "weighted";
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
  protocolMappings?: ProtocolMapping | null;
  apiKey: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateProviderRequest {
  name?: string;
  description?: string | null;
  baseUrl?: string;
  protocolMappings?: ProtocolMapping | null;
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
  modelId?: string | null;
  routingStrategy?: VirtualKeyRoutingStrategy;
  modelIds?: string[];
  routingConfig?: RoutingConfig;
  keyType: "auto" | "custom";
  customKey?: string;
  /** Explicit null clears a setting; omitting it leaves the stored value alone. */
  rateLimit?: number | null;
  enabled?: boolean;
  cacheEnabled?: boolean;
  disableLogging?: boolean;
  contextBudgetTokens?: number | null;
  imageCompressionEnabled?: boolean;
  interceptZeroTemperature?: boolean;
  zeroTemperatureReplacement?: number | null;
  piiProtectionEnabled?: boolean;
}

export interface UpdateVirtualKeyRequest {
  name?: string;
  providerId?: string;
  modelId?: string | null;
  routingStrategy?: VirtualKeyRoutingStrategy;
  modelIds?: string[];
  routingConfig?: RoutingConfig;
  enabled?: boolean;
  rateLimit?: number | null;
  cacheEnabled?: boolean;
  disableLogging?: boolean;
  contextBudgetTokens?: number | null;
  imageCompressionEnabled?: boolean;
  interceptZeroTemperature?: boolean;
  zeroTemperatureReplacement?: number | null;
  piiProtectionEnabled?: boolean;
}
