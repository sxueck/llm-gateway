/**
 * 后端协议工具函数
 * 导入共享的协议类型和基础函数，并提供后端特定的扩展功能
 */
export * from './protocol-types.js';

/**
 * 判断协议配置是否为 Anthropic
 * @param protocolConfig 协议配置对象，包含 protocol 字段
 * @returns 如果是 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocolConfig(protocolConfig: { protocol?: string }): boolean {
  return protocolConfig.protocol === 'anthropic';
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
