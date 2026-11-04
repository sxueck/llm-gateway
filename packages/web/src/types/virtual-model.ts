import { resolveDefaultTimezone, type TimePriorityTimeRule } from '@/utils/time-priority';

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
  /** time_priority 模式：IANA 时区 */
  timezone?: string;
  /** time_priority 模式：时段规则 */
  timeRules?: TimePriorityTimeRule[];
}

export type RoutingConfigType = 'loadbalance' | 'fallback' | 'hash' | 'affinity' | 'time_priority';

export type { TimePriorityTimeRule };

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
    timezone: resolveDefaultTimezone(),
    timeRules: [],
  };
}