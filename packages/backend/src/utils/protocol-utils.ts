/**
 * 后端协议工具函数
 *
 * Re-export shared protocol types/helpers, then add backend-only helpers.
 */
export * from '@llm-gateway/shared/utils';

/**
 * 判断协议配置是否为 Anthropic
 * @param protocolConfig 协议配置对象，包含 protocol 字段
 * @returns 如果是 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocolConfig(protocolConfig: { protocol?: string }): boolean {
  return protocolConfig.protocol === 'anthropic';
}

/**
 * 供应商对外提供的协议集合：base_url 始终意味着 openai 协议，
 * protocol_mappings 中配置了非空 baseURL 的协议（anthropic/google/openai）额外可用。
 * 模型不再单独声明协议——下属全部模型继承供应商的能力。
 */
export function getProviderSupportedProtocols(
  provider: { base_url?: string | null; protocol_mappings?: string | null } | null | undefined,
): string[] {
  const offered = new Set<string>();

  if (provider && (provider.base_url || '').trim()) {
    offered.add('openai');
  }

  if (provider?.protocol_mappings) {
    let mappings: Record<string, unknown> | null = null;
    try {
      mappings = JSON.parse(provider.protocol_mappings);
    } catch {
      // 非法 JSON 时仅依赖 base_url，转发路径会记录原始配置错误
    }
    if (mappings && typeof mappings === 'object') {
      for (const protocol of ['openai', 'anthropic', 'google']) {
        const url = (mappings as any)[protocol];
        if (typeof url === 'string' && url.trim()) {
          offered.add(protocol);
        }
      }
    }
  }

  return ['openai', 'anthropic', 'google'].filter(p => offered.has(p));
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
    } catch {
      // 解析失败时静默失败，使用默认 base_url
    }
  }

  return baseUrl;
}
