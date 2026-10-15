export type VirtualKeyFormKeyType = 'auto' | 'custom';

export interface VirtualKeyFormValue {
  name: string;
  modelIds: string[];
  keyType: VirtualKeyFormKeyType;
  customKey: string;
  rateLimit: number | undefined;
  enabled: boolean;
  cacheEnabled: boolean;
  disableLogging: boolean;
  /** 上下文预算档位 tokens（200K/400K/600K/800K），null=关闭 */
  contextBudgetTokens: number | null;
  imageCompressionEnabled: boolean;
  interceptZeroTemperature: boolean;
  zeroTemperatureReplacement: number | undefined;
  piiProtectionEnabled: boolean;
  promptCaptureEnabled: boolean;
}

export function createDefaultVirtualKeyForm(): VirtualKeyFormValue {
  return {
    name: '',
    modelIds: [],
    keyType: 'auto',
    customKey: '',
    rateLimit: undefined,
    enabled: true,
    cacheEnabled: false,
    disableLogging: false,
    contextBudgetTokens: null,
    imageCompressionEnabled: false,
    interceptZeroTemperature: false,
    zeroTemperatureReplacement: 0.7,
    piiProtectionEnabled: false,
    promptCaptureEnabled: false,
  };
}
