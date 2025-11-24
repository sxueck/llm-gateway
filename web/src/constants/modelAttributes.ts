export interface AttributeConfig {
  key: keyof import('@/types').ModelAttributes;
  label: string;
  labelKey?: string; // i18n key for label
  description: string;
  descriptionKey?: string; // i18n key for description
  type: 'number' | 'boolean';
  category: '成本参数';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

export const MODEL_ATTRIBUTE_CONFIGS: AttributeConfig[] = [
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
];

export const ATTRIBUTE_CATEGORIES = ['成本参数'] as const;

export function getAttributesByCategory(category: typeof ATTRIBUTE_CATEGORIES[number]) {
  return MODEL_ATTRIBUTE_CONFIGS.filter(attr => attr.category === category);
}

export function getAttributeConfig(key: string) {
  return MODEL_ATTRIBUTE_CONFIGS.find(attr => attr.key === key);
}

