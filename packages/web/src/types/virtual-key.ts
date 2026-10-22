export type VirtualKeyFormKeyType = 'auto' | 'custom';

export interface VirtualKeyFormValue {
  name: string;
  modelIds: string[];
  keyType: VirtualKeyFormKeyType;
  customKey: string;
  /** null = 不限（NInputNumber 清空时 emit null，与后端显式清除契约一致） */
  rateLimit: number | null;
  enabled: boolean;
  cacheEnabled: boolean;
  disableLogging: boolean;
  /** 上下文预算档位 tokens（200K/400K/600K/800K），null=关闭 */
  contextBudgetTokens: number | null;
  imageCompressionEnabled: boolean;
  interceptZeroTemperature: boolean;
  /** null = 未设置替换值 */
  zeroTemperatureReplacement: number | null;
  piiProtectionEnabled: boolean;
}

export function createDefaultVirtualKeyForm(): VirtualKeyFormValue {
  return {
    name: '',
    modelIds: [],
    keyType: 'auto',
    customKey: '',
    rateLimit: null,
    enabled: true,
    cacheEnabled: false,
    disableLogging: false,
    contextBudgetTokens: null,
    imageCompressionEnabled: false,
    interceptZeroTemperature: false,
    zeroTemperatureReplacement: 0.7,
    piiProtectionEnabled: false,
  };
}
