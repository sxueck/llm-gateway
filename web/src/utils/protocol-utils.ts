/**
 * 判断模型是否使用 Anthropic 协议
 * @param model 模型对象，包含 protocol 字段
 * @returns 如果使用 Anthropic 协议返回 true，否则返回 false
 */
export function isAnthropicProtocol(model: { protocol?: string | null }): boolean {
  return model.protocol === 'anthropic';
}
