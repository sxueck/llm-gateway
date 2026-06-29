/**
 * 后端协议工具函数
 *
 * Re-export shared protocol types/helpers, then add backend-only helpers.
 */
export * from '@llm-gateway/shared/utils';
import { memoryLogger } from '../services/logger.js';

/**
 * 判断协议配置是否为 Anthropic
 * @param protocolConfig 协议配置对象，包含 protocol 字段
 * @returns 如果是 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocolConfig(protocolConfig: { protocol?: string }): boolean {
  return protocolConfig.protocol === 'anthropic';
}

/**
 * 解析模型的 supported_protocols JSON 字符串。
 * - NULL / 空 / 仅空白符 → 返回 ["openai"] 并记录警告。
 * - 非法 JSON → 抛出配置错误异常。
 */
export function parseSupportedProtocols(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) {
    memoryLogger.warn('模型 supported_protocols 为空，回退到默认 ["openai"]', 'Protocol');
    return ['openai'];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    memoryLogger.warn('模型 supported_protocols 为空数组，回退到默认 ["openai"]', 'Protocol');
    return ['openai'];
  } catch (e: any) {
    throw new Error(`模型 supported_protocols 配置错误: ${e.message}`);
  }
}

/**
 * 确定探测使用的协议：优先 health_check_protocol，否则取 supported_protocols 第一项。
 */
export function resolveProbeProtocol(model: { supported_protocols: string | null; health_check_protocol: string | null }): string {
  if (model.health_check_protocol) {
    return model.health_check_protocol;
  }
  const supported = parseSupportedProtocols(model.supported_protocols);
  return supported[0];
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
