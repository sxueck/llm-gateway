export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
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
  base_url: string;
  api_key: string;
  model_mapping: string | null;
  protocol_mappings: string | null; // JSON string of ProtocolMapping
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
  disable_logging: number;
  dynamic_compression_enabled: number;
  intercept_zero_temperature: number;
  zero_temperature_replacement: number | null;
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
  // Cost Parameters
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_token_cache_hit?: number;

  // Configuration
  litellm_provider?: string;
  mode?: string;
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  requestTimeout?: number;
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
    ignored_tags?: string[];
    enable_structured_output?: boolean;
  };
  experts: import('./expert-routing.js').ExpertTarget[];
  fallback?: {
    type: 'virtual' | 'real';
    model_id?: string;
    provider_id?: string;
    model?: string;
  };
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
  original_request?: string | null;
  classifier_request?: string | null;
  classifier_response?: string | null;
}

export interface BackupRecord {
  id: string;
  backup_key: string;
  backup_type: 'full' | 'incremental';
  includes_logs: number;
  file_size: number | null;
  file_hash: string | null;
  s3_key: string;
  encryption_key_hash: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
  record_count: number | null;
  checksum: string | null;
  created_at: number;
}

export interface RestoreRecord {
  id: string;
  backup_record_id: string;
  restore_type: 'full' | 'partial';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rollback';
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
  backup_before_restore: string | null;
  changes_made: string | null; // JSON string
  rollback_data: string | null; // JSON string
  created_at: number;
}

export interface BackupOptions {
  includes_logs?: boolean;
  backup_type?: 'full' | 'incremental';
}

export interface RestoreOptions {
  restore_type?: 'full' | 'partial';
  create_backup_before_restore?: boolean;
  verify_data?: boolean;
  tables_to_restore?: string[];
}

