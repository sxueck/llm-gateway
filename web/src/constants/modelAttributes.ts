export interface AttributeConfig {
  key: keyof import('@/types').ModelAttributes;
  label: string;
  description: string;
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
    description: '每个输入令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/token',
    min: 0,
    step: 0.000001,
  },
  {
    key: 'output_cost_per_token',
    label: '输出成本',
    description: '每个输出令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/token',
    min: 0,
    step: 0.000001,
  },
  {
    key: 'input_cost_per_token_cache_hit',
    label: '缓存命中成本',
    description: '缓存命中时每个输入令牌的成本',
    type: 'number',
    category: '成本参数',
    unit: '$/token',
    min: 0,
    step: 0.000001,
  },
  {
    key: 'supports_function_calling',
    label: '函数调用',
    description: '是否支持函数调用功能',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_vision',
    label: '视觉理解',
    description: '是否支持图像输入和理解',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_tool_choice',
    label: '工具选择',
    description: '是否支持指定工具选择策略',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_assistant_prefill',
    label: '助手预填充',
    description: '是否支持助手消息预填充',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_prompt_caching',
    label: '提示词缓存',
    description: '是否支持提示词缓存以降低成本',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_reasoning',
    label: '推理能力',
    description: '是否支持高级推理功能',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_audio_input',
    label: '音频输入',
    description: '是否支持音频输入',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_audio_output',
    label: '音频输出',
    description: '是否支持音频输出',
    type: 'boolean',
    category: '功能支持',
  },
  {
    key: 'supports_pdf_input',
    label: 'PDF输入',
    description: '是否支持PDF文档输入',
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

