export interface VirtualModelTarget {
  providerId: string;
  modelName?: string;
  weight?: number;
  onStatusCodes?: number[];
}

export interface VirtualModelFormValue {
  name: string;
  description: string;
  targets: VirtualModelTarget[];
  createVirtualModel: boolean;
  virtualModelName: string;
  modelAttributes?: any;
  hashSource?: 'virtualKey' | 'request';
  affinityTTLSeconds?: number;
}

export type RoutingConfigType = 'loadbalance' | 'fallback' | 'hash' | 'affinity';

export function createDefaultVirtualModelForm(): VirtualModelFormValue {
  return {
    name: '',
    description: '',
    targets: [],
    createVirtualModel: true,
    virtualModelName: '',
    modelAttributes: undefined,
    hashSource: 'virtualKey',
    affinityTTLSeconds: 300,
  };
}