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
  dynamicCompressionEnabled: boolean;
  interceptZeroTemperature: boolean;
  zeroTemperatureReplacement: number | undefined;
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
    dynamicCompressionEnabled: false,
    interceptZeroTemperature: false,
    zeroTemperatureReplacement: 0.7,
  };
}
