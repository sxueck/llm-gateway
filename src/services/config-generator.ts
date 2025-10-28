import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { appConfig } from '../config/index.js';
import { providerDb, virtualKeyDb } from '../db/index.js';
import { decryptApiKey } from '../utils/crypto.js';
import { PortkeyConfig } from '../types/index.js';
import { ProviderAdapterFactory } from './provider-adapter.js';

export async function generatePortkeyConfig(): Promise<string> {
  const providers = await providerDb.getAll();
  const virtualKeys = await virtualKeyDb.getAll();

  const config: PortkeyConfig = {
    credentials: {},
    virtual_keys: {},
  };

  for (const provider of providers) {
    if (provider.enabled) {
      const apiKey = decryptApiKey(provider.api_key).trim();
      const baseUrl = (provider.base_url || '').trim();

      const normalized = ProviderAdapterFactory.normalizeProviderConfig({
        provider: provider.id,
        baseUrl,
        apiKey,
      });

      config.credentials[provider.id] = {
        provider: normalized.provider,
        api_key: normalized.apiKey,
        base_url: normalized.baseUrl,
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

