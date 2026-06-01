export interface AttributeConfig {
  key: keyof import('@/types').ModelAttributes;
  label: string;
  labelKey?: string; // i18n key for label
  description: string;
  descriptionKey?: string; // i18n key for description
  type: 'number' | 'boolean';
  category: '成本参数' | '协议优化';
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
  {
    key: 'upstream_websocket_enabled',
    label: '上游 WebSocket',
    labelKey: 'modelAttributes.upstreamWebsocket.label',
    description: '对 Responses API 流式请求使用上游 WebSocket 连接，可降低多轮工具调用的延迟',
    descriptionKey: 'modelAttributes.upstreamWebsocket.description',
    type: 'boolean',
    category: '协议优化',
  },
];

export const ATTRIBUTE_CATEGORIES = ['协议优化', '成本参数'] as const;

export function getAttributesByCategory(category: typeof ATTRIBUTE_CATEGORIES[number]) {
  return MODEL_ATTRIBUTE_CONFIGS.filter(attr => attr.category === category);
}

export function getAttributeConfig(key: string) {
  return MODEL_ATTRIBUTE_CONFIGS.find(attr => attr.key === key);
}

