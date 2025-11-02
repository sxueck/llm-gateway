export interface AttributeConfig {
  key: keyof import('@/types').ModelAttributes;
  label: string;
  labelKey?: string; // i18n key for label
  description: string;
  descriptionKey?: string; // i18n key for description
  type: 'number' | 'boolean';
  category: '性能参数' | '成本参数' | '功能支持';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

export const MODEL_ATTRIBUTE_CONFIGS: AttributeConfig[] = [
  {
    key: 'max_tokens',
    label: '最大令牌数',
    description: '模型单次生成的最大令牌数量',
    type: 'number',
    category: '性能参数',
    unit: 'tokens',
    min: 1,
    step: 1,
  },
  {
    key: 'max_input_tokens',
    label: '最大输入令牌数',
    description: '模型支持的最大输入上下文长度',
    type: 'number',
    category: '性能参数',
    unit: 'tokens',
    min: 1,
    step: 1,
  },
  {
    key: 'max_output_tokens',
    label: '最大输出令牌数',
    description: '模型单次生成的最大输出令牌数',
    type: 'number',
    category: '性能参数',
    unit: 'tokens',
    min: 1,
    step: 1,
  },
  {
    key: 'input_cost_per_token',
    label: '输入成本',
    description: '每百万输入令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/Mtoken',
    min: 0,
    step: 0.001,
  },
  {
    key: 'output_cost_per_token',
    label: '输出成本',
    description: '每百万输出令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/Mtoken',
    min: 0,
    step: 0.001,
  },
  {
    key: 'input_cost_per_token_cache_hit',
    label: '缓存命中成本',
    description: '缓存命中时每百万输入令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/Mtoken',
    min: 0,
    step: 0.001,
  },
  {
    key: 'supports_reasoning',
    label: '推理能力',
    labelKey: 'modelAttributes.features.reasoning.label',
    description: '关闭后无法进行思考',
    descriptionKey: 'modelAttributes.features.reasoning.description',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_vision',
    label: '视觉理解',
    labelKey: 'modelAttributes.features.vision.label',
    description: '支持图像输入和理解',
    descriptionKey: 'modelAttributes.features.vision.description',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_prompt_caching',
    label: '提示词缓存',
    labelKey: 'modelAttributes.features.promptCaching.label',
    description: '支持缓存以降低成本',
    descriptionKey: 'modelAttributes.features.promptCaching.description',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_audio_output',
    label: '音频输出',
    labelKey: 'modelAttributes.features.audioOutput.label',
    description: '支持音频输出',
    descriptionKey: 'modelAttributes.features.audioOutput.description',
    type: 'boolean',
    category: '功能支持',
  },
];

export const ATTRIBUTE_CATEGORIES = ['性能参数', '成本参数', '功能支持'] as const;

export function getAttributesByCategory(category: typeof ATTRIBUTE_CATEGORIES[number]) {
  return MODEL_ATTRIBUTE_CONFIGS.filter(attr => attr.category === category);
}

export function getAttributeConfig(key: string) {
  return MODEL_ATTRIBUTE_CONFIGS.find(attr => attr.key === key);
}

