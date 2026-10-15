import { providerDb, modelDb } from '../../db/index.js';

export interface ResolvedModel {
  provider?: any;
  providerId?: string;
  modelOverride?: string;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
}

export async function resolveModelConfig(
  config: { type: 'virtual' | 'real'; model_id?: string; provider_id?: string; model?: string },
  configType: string
): Promise<ResolvedModel> {
  if (config.type === 'virtual') {
    const virtualModel = await modelDb.getById(config.model_id!);
    if (!virtualModel || !virtualModel.enabled) {
      throw new Error(`${configType} virtual model unavailable: ${config.model_id}`);
    }
    return {
      expertType: 'virtual',
      expertName: virtualModel.name,
      expertModelId: config.model_id,
    };
  }
  const provider = await providerDb.getById(config.provider_id!);
  if (!provider || provider.enabled === 0) {
    throw new Error(`${configType} provider unavailable: ${config.provider_id}`);
  }
  return {
    provider,
    providerId: config.provider_id,
    modelOverride: config.model,
    expertType: 'real',
    expertName: `${provider.name}/${config.model}`,
  };
}
