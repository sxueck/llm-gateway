export interface ExpertTarget {
  id: string;
  category: string;
  type: 'virtual' | 'real';
  model_id?: string;
  provider_id?: string;
  model?: string;
  description?: string;
  color?: string;
  system_prompt?: string;
}

/**
 * Local ONNX classifier policy. The actual rejection policy is loaded from the
 * pinned model artifact directory (rejection_policy.json); this struct only
 * records pin metadata for logging, readiness checks, and audit.
 */
export interface LocalClassifierPolicy {
  model_repo: string;
  revision: string;
  onnx_file: string;
  max_tokens: number;
}

/**
 * Session binding TTL policy (NFR-4). Both values must be positive and
 * idle_ttl_seconds must be <= absolute_ttl_seconds.
 */
export interface SessionBindingPolicy {
  idle_ttl_seconds: number;
  absolute_ttl_seconds: number;
}

/**
 * LLM second-pass classifier configuration. Repurposes the former primary
 * `classifier` model wiring; invoked only when local ONNX rejects, returns an
 * ineligible label (ops/out_of_scope), or lacks a mapped expert.
 */
export interface LlmSecondPassConfig {
  type: 'virtual' | 'real';
  model_id?: string;
  provider_id?: string;
  model?: string;
  prompt_template: string;
  system_prompt?: string;
  user_prompt_marker?: string;
  max_tokens?: number;
  temperature?: number;
  timeout?: number;
  ignore_system_messages?: boolean;
  max_messages_to_classify?: number;
  ignored_tags?: string[];
  enable_structured_output?: boolean;
  enable_adaptive_thinking?: boolean;
}

export interface FallbackConfig {
  type: 'virtual' | 'real';
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ModelConfig {
  type: 'virtual' | 'real';
  model_id?: string;
  provider_id?: string;
  model?: string;
}

export interface ResolvedModelInfo {
  provider?: any;
  providerId?: string;
  modelOverride?: string;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
}
