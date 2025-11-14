/**
 * 虚拟模型相关的共享类型定义
 */

export interface VirtualModelTarget {
  providerId: string;
  modelId?: string;
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