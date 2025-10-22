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

export interface ClassifierConfig {
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

