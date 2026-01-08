import { systemConfigDb } from '../db/index.js';

export interface AifwMaskConfig {
  maskAddress?: boolean;
  maskEmail?: boolean;
  maskOrganization?: boolean;
  maskUserName?: boolean;
  maskPhoneNumber?: boolean;
  maskBankNumber?: boolean;
  maskPayment?: boolean;
  maskVerificationCode?: boolean;
  maskPassword?: boolean;
  maskRandomSeed?: boolean;
  maskPrivateKey?: boolean;
  maskUrl?: boolean;
  maskAll?: boolean;
}

// Mirrors OneAIFW documented defaults (oneaifw_services_api_cn.md).
// Used as a UI-friendly preset; if you want to truly rely on OneAIFW server defaults,
// leave maskConfigJson empty.
export const DEFAULT_AIFW_MASK_CONFIG: Required<Omit<AifwMaskConfig, 'maskAll'>> = {
  maskAddress: false,
  maskEmail: true,
  maskOrganization: true,
  maskUserName: true,
  maskPhoneNumber: true,
  maskBankNumber: true,
  maskPayment: true,
  maskVerificationCode: true,
  maskPassword: true,
  maskRandomSeed: true,
  maskPrivateKey: true,
  maskUrl: true,
};

export interface AifwConfig {
  enabled: boolean;
  baseUrl: string;
  httpApiKey?: string;
  failOpen: boolean;
  timeoutMs: number;
  maskConfig?: AifwMaskConfig;
}

const DEFAULT_CONFIG: AifwConfig = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:8844',
  httpApiKey: undefined,
  failOpen: false,
  timeoutMs: 5000,
  maskConfig: undefined,
};

function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return DEFAULT_CONFIG.baseUrl;
  return trimmed.replace(/\/+$/, '');
}

function parseJsonObject(raw: string | undefined | null): any | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function loadAifwConfig(): Promise<AifwConfig> {
  const enabledCfg = await systemConfigDb.get('aifw_enabled');
  const baseUrlCfg = await systemConfigDb.get('aifw_base_url');
  const apiKeyCfg = await systemConfigDb.get('aifw_http_api_key');
  const failOpenCfg = await systemConfigDb.get('aifw_fail_open');
  const timeoutCfg = await systemConfigDb.get('aifw_timeout_ms');
  const maskCfgJson = await systemConfigDb.get('aifw_mask_config_json');

  const timeoutMsRaw = timeoutCfg ? Number(timeoutCfg.value) : DEFAULT_CONFIG.timeoutMs;
  const timeoutMs = Number.isFinite(timeoutMsRaw)
    ? Math.min(60_000, Math.max(500, Math.floor(timeoutMsRaw)))
    : DEFAULT_CONFIG.timeoutMs;

  return {
    enabled: enabledCfg ? enabledCfg.value === 'true' : DEFAULT_CONFIG.enabled,
    baseUrl: normalizeBaseUrl(baseUrlCfg?.value || DEFAULT_CONFIG.baseUrl),
    httpApiKey: apiKeyCfg?.value ? String(apiKeyCfg.value) : undefined,
    failOpen: failOpenCfg ? failOpenCfg.value === 'true' : DEFAULT_CONFIG.failOpen,
    timeoutMs,
    maskConfig: parseJsonObject(maskCfgJson?.value) as AifwMaskConfig | undefined,
  };
}
