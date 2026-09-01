export interface AttributeConfig {
  key: keyof import('@/types').ModelAttributes;
  label: string;
  labelKey?: string; // i18n key for label
  description: string;
  descriptionKey?: string; // i18n key for description
  type: 'number' | 'boolean';
  category: '服务限制' | '协议优化' | '成本参数';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}

export const MODEL_ATTRIBUTE_CONFIGS: AttributeConfig[] = [
  {
    key: 'max_completion_tokens',
    label: '实际输出上限',
    labelKey: 'modelAttributes.maxCompletionTokens.label',
    description: '本网关实际接受并转发的最大补全 tokens（serving cap）。会通过 /v1/models 的 max_completion_tokens 字段与响应头 X-Max-Completion-Tokens 下发；请求中的 max_tokens 超出时会被钳制到该值',
    descriptionKey: 'modelAttributes.maxCompletionTokens.description',
    type: 'number',
    category: '服务限制',
    min: 1,
    step: 1,
  },
  {
    key: 'context_window',
    label: '上下文窗口',
    labelKey: 'modelAttributes.contextWindow.label',
    description: '模型的上下文窗口（input + output），通过 /v1/models 的 context_window 字段下发。未填写时回退到目录的 context_length / max_tokens',
    descriptionKey: 'modelAttributes.contextWindow.description',
    type: 'number',
    category: '服务限制',
    min: 1,
    step: 1,
  },
  {
    key: 'disable_thinking',
    label: '关闭思考',
    labelKey: 'modelAttributes.disableThinking.label',
    description: '开启后网关会移除请求中的思考控制参数（reasoning_effort / reasoning / thinking），Anthropic 协议强制 thinking: disabled，Gemini 协议将 thinkingBudget 置 0，OpenAI 协议附上 enable_thinking: false（不识别该参数的提供商可能报错，请仅对支持的模型开启）。适合 instant 等无需思考的场景',
    descriptionKey: 'modelAttributes.disableThinking.description',
    type: 'boolean',
    category: '服务限制',
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
    key: 'upstream_websocket_enabled',
    label: '上游 WebSocket',
    labelKey: 'modelAttributes.upstreamWebsocket.label',
    description: '对 Responses API 流式请求使用上游 WebSocket 连接，可降低多轮工具调用的延迟',
    descriptionKey: 'modelAttributes.upstreamWebsocket.description',
    type: 'boolean',
    category: '协议优化',
  },
];

export const ATTRIBUTE_CATEGORIES = ['服务限制', '协议优化', '成本参数'] as const;

export function getAttributesByCategory(category: typeof ATTRIBUTE_CATEGORIES[number]) {
  return MODEL_ATTRIBUTE_CONFIGS.filter(attr => attr.category === category);
}

export function getAttributeConfig(key: string) {
  return MODEL_ATTRIBUTE_CONFIGS.find(attr => attr.key === key);
}

