import type { ProtocolMapping } from '@/types';

export interface ProviderFormValue {
  id: string;
  name: string;
  description?: string | null;
  baseUrl: string;
  protocolMappings?: ProtocolMapping | null;
  apiKey: string;
  /** 归属 节点 ID；空字符串表示默认控制节点（提交时转 null） */
  ownerNode: string;
  enabled: boolean;
}

export function createDefaultProviderForm(): ProviderFormValue {
  return {
    id: '',
    name: '',
    description: '',
    baseUrl: '',
    protocolMappings: null,
    apiKey: '',
    ownerNode: '',
    enabled: true,
  };
}
