import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { appConfig } from '../config/index.js';
import { providerDb, virtualKeyDb } from '../db/index.js';
import { decryptApiKey } from '../utils/crypto.js';
import { PortkeyConfig } from '../types/index.js';

function getPortkeyProviderType(baseUrl: string): string {
  const url = baseUrl.toLowerCase();

  if (url.includes('api.deepseek.com')) {
    return 'openai';
  }
  if (url.includes('api.openai.com')) {
    return 'openai';
  }
  if (url.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return 'google';
  }

  return 'openai';
}

export async function generatePortkeyConfig(): Promise<string> {
  const providers = providerDb.getAll();
  const virtualKeys = virtualKeyDb.getAll();

  const config: PortkeyConfig = {
    credentials: {},
    virtual_keys: {},
  };

  for (const provider of providers) {
    if (provider.enabled) {
      const apiKey = decryptApiKey(provider.api_key).trim();
      let baseUrl = (provider.base_url || '').trim().replace(/\/+$/, '');
      baseUrl = baseUrl.replace(/\/v1$/, '');
      const portkeyProvider = getPortkeyProviderType(baseUrl);

      config.credentials[provider.id] = {
        provider: portkeyProvider,
        api_key: apiKey,
        base_url: baseUrl,
      };
    }
  }

  for (const vk of virtualKeys) {
    if (vk.enabled) {
      const entry: any = {
        provider: vk.provider_id,
      };

      const provider = providers.find(p => p.id === vk.provider_id);
      if (provider?.model_mapping) {
        try {
          entry.override_params = JSON.parse(provider.model_mapping);
        } catch (e) {
          // 忽略无效的 JSON
        }
      }

      config.virtual_keys[vk.key_value] = entry;
    }
  }

  await mkdir(dirname(appConfig.portkeyConfigPath), { recursive: true });
  await writeFile(appConfig.portkeyConfigPath, JSON.stringify(config, null, 2), 'utf-8');

  return appConfig.portkeyConfigPath;
}

