export type ProtocolType = 'openai' | 'anthropic' | 'google';

export interface ProtocolInfo {
  label: string;
  type: 'info' | 'success' | 'warning' | 'default';
}

export const PROTOCOL_MAP: Record<ProtocolType, ProtocolInfo> = {
  openai: { label: 'OpenAI', type: 'info' },
  anthropic: { label: 'Anthropic', type: 'success' },
  google: { label: 'Google', type: 'warning' },
};

export const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 协议', value: 'openai' },
  { label: 'Anthropic 协议 (Claude)', value: 'anthropic' },
  { label: 'Google 协议 (Gemini)', value: 'google' },
];

export function isAnthropicProtocol(model: { protocol?: string | null }): boolean {
  return model.protocol === 'anthropic';
}

export function isGeminiProtocol(model: { protocol?: string | null }): boolean {
  return model.protocol === 'google';
}

export function getProtocolInfo(protocol: string | null | undefined): ProtocolInfo {
  if (!protocol) {
    return PROTOCOL_MAP.openai;
  }
  return PROTOCOL_MAP[protocol as ProtocolType] || { label: protocol, type: 'info' };
}
