import type { ClassifierConfig, CreateExpertRoutingRequest } from '@/api/expert-routing';

export function createDefaultClassifierConfig(): ClassifierConfig {
  return {
    type: 'real',
    prompt_template: '',
    max_tokens: 50,
    temperature: 0.1,
    timeout: 10000,
    ignore_system_messages: false,
    max_messages_to_classify: 0,
  };
}

export function createDefaultExpertRoutingConfig(): CreateExpertRoutingRequest {
  return {
    name: '',
    description: '',
    enabled: true,
    classifier: createDefaultClassifierConfig(),
    experts: [],
  };
}

