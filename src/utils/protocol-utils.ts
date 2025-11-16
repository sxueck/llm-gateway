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
 * 判断协议配置是否为 Anthropic
 * @param protocolConfig 协议配置对象，包含 protocol 字段
 * @returns 如果是 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocolConfig(protocolConfig: { protocol?: string }): boolean {
  return protocolConfig.protocol === 'anthropic';
}

/**
 * 获取协议显示信息
 * @param protocol 协议类型
 * @returns 协议显示信息，如果未找到则返回默认信息
 */
export function getProtocolInfo(protocol: string | null | undefined): ProtocolInfo {
  if (!protocol) {
    return { label: '默认', type: 'default' };
  }
  return PROTOCOL_MAP[protocol as ProtocolType] || { label: protocol, type: 'info' };
}

/**
 * 根据模型协议获取正确的 baseURL
 * 支持多协议：优先使用 protocol_mappings 中的 URL，否则使用默认 base_url
 * @param provider 提供商对象，包含 base_url 和 protocol_mappings
 * @param protocol 协议类型
 * @returns 对应协议的 baseURL
 */
export function getBaseUrlForProtocol(
  provider: { base_url: string; protocol_mappings: string | null },
  protocol: string | null
): string {
  let baseUrl = provider.base_url || '';

  if (provider.protocol_mappings && protocol) {
    try {
      const protocolMappings = JSON.parse(provider.protocol_mappings);
      const protocolSpecificUrl = protocolMappings[protocol];

      if (protocolSpecificUrl) {
        baseUrl = protocolSpecificUrl;
      }
    } catch (e: any) {
      // 解析失败时静默失败，使用默认 base_url
    }
  }

  return baseUrl;
}
