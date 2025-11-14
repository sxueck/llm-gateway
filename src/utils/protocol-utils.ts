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
