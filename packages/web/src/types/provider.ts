import type { ProtocolMapping } from '@/types';

export interface ProviderFormValue {
  id: string;
  name: string;
  description?: string | null;
  baseUrl: string;
  protocolMappings?: ProtocolMapping | null;
  apiKey: string;
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
    enabled: true,
  };
}
