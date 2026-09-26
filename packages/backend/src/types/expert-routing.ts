/** Price/quality band of an expert candidate. `low` = cheapest. */
export type RoutingBand = "low" | "medium" | "high";

/** PR-2: what to do when the classification chain is exhausted. */
export type FailOpenMode = "fallback" | "parent" | "error";

/** PR-1: JEV classifies into expert candidates, or into a fixed difficulty. */
export type ClassificationMode = "expert" | "difficulty";

/** Fixed difficulty vocabulary used in `difficulty` classification mode. */
export type DifficultyLevel = "low" | "medium" | "high";

/** Per-token cost inputs used for band pricing (may be absent = unknown). */
export interface CostInput {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

export interface ExpertTarget {
  id: string;
  category: string;
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
  description?: string;
  color?: string;
  /** Explicit band override; experts without one are auto-banded by price. */
  band?: RoutingBand;
}

export interface ExpertRoutingBands {
  low: ExpertTarget[];
  medium: ExpertTarget[];
  high: ExpertTarget[];
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
