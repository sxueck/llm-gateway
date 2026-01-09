/**
 * 协议类型定义
 */
export type ProtocolType = 'openai' | 'anthropic' | 'google';

/**
 * 协议显示信息
 */
export interface ProtocolInfo {
  label: string;
  type: 'info' | 'success' | 'warning' | 'default';
}

/**
 * 协议映射配置
 * 统一的协议显示信息，供前后端共享使用
 */
export const PROTOCOL_MAP: Record<ProtocolType, ProtocolInfo> = {
  openai: { label: 'OpenAI', type: 'info' },
  anthropic: { label: 'Anthropic', type: 'success' },
  google: { label: 'Google', type: 'warning' },
};

/**
 * 协议选项列表
 * 用于下拉选择框
 */
export const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 协议', value: 'openai' },
  { label: 'Anthropic 协议 (Claude)', value: 'anthropic' },
  { label: 'Google 协议 (Gemini)', value: 'google' },
];

/**
 * 判断模型是否使用 Anthropic 协议
 * @param model 模型对象，包含 protocol 字段
 * @returns 如果使用 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocol(model: { protocol?: string | null }): boolean {
  return model.protocol === 'anthropic';
}

/**
 * 判断模型是否使用 Gemini 协议
 * @param model 模型对象，包含 protocol 字段
 * @returns 如果使用 Gemini 协议返回 true，否则返回 false
 */
export function isGeminiProtocol(model: { protocol?: string | null }): boolean {
  return model.protocol === 'google';
}

/**
 * 获取协议显示信息
 * @param protocol 协议类型
 * @returns 协议显示信息，如果未找到则返回默认信息
 */
export function getProtocolInfo(protocol: string | null | undefined): ProtocolInfo {
  if (!protocol) {
    return PROTOCOL_MAP.openai;
  }
  return PROTOCOL_MAP[protocol as ProtocolType] || { label: protocol, type: 'info' };
}