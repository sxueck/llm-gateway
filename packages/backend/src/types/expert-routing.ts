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

/**
 * Session binding TTL policy (NFR-4). Both values must be positive and
 * idle_ttl_seconds must be <= absolute_ttl_seconds.
 */
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

export interface ModelConfig {
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ResolvedModelInfo {
  provider?: any;
  providerId?: string;
  modelOverride?: string;
  expertType: "virtual" | "real";
  expertName: string;
  expertModelId?: string;
}
