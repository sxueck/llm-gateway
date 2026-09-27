/** Price/quality band of an expert candidate. `low` = cheapest. */
export type RoutingBand = "low" | "medium" | "high";

/** PR-2: what to do when the classification chain is exhausted. */
export type FailOpenMode = "fallback" | "parent" | "error";

/** Fixed difficulty vocabulary used by the Jev difficulty classifier. */
export type DifficultyLevel = "low" | "medium" | "high";

/** Per-token cost inputs used for band pricing (may be absent = unknown). */
export interface CostInput {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

export interface ExpertTarget {
  id: string;
  /** v2: mandatory band; array order breaks ties within a band. */
  band: RoutingBand;
  type: "virtual" | "real";
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ExpertRoutingBands {
  low: ExpertTarget[];
  medium: ExpertTarget[];
  high: ExpertTarget[];
}

/**
 * Session policy (v2 §5.1). `escalate_only` re-classifies each new user turn
 * and only allows moving up; `per_turn` re-classifies every turn without
 * bindings; `sticky` keeps the legacy first-verdict binding.
 */
export type SessionPolicyMode = "per_turn" | "sticky" | "escalate_only";

export interface SessionPolicy {
  mode: SessionPolicyMode;
  idle_ttl_seconds: number;
  absolute_ttl_seconds: number;
}

/** Legacy alias kept for historical configs still using the old key. */
export type SessionBindingPolicy = SessionPolicy;

/** Classifier tuning (v2 §5.5): timeout and low-confidence handling. */
export interface ClassifierConfig {
  timeout_ms?: number;
  on_low_confidence?: "escalate" | "keep";
  min_confidence?: number;
}

/** How routing facts are exposed to the client (v2 §4). */
export interface ExposureConfig {
  /** Emit X-Gateway-Route-* response headers (default true). */
  headers?: boolean;
  /** Also emit X-Gateway-Provider (default false; leaks provider info). */
  provider_header?: boolean;
  /** Which model id the body `model` field reports (default "upstream"). */
  model_field?: "upstream" | "gateway_name";
  /** Emit a leading SSE comment line `: x-gateway-route {...}` (default false). */
  sse_comment?: boolean;
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
