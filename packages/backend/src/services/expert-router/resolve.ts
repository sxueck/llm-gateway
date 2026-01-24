
import { providerDb, modelDb, routingConfigDb } from '../../db/index.js';
import { ExpertRoutingConfig } from '../../types/index.js';
import { ExpertTarget } from '../../types/expert-routing.js';

export interface ClassifierModelResult {
  provider: any;
  model: string;
}

export interface ResolvedModel {
  provider?: any;
  providerId?: string;
  modelOverride?: string;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
}

/**
 * 解析分类器模型配置，获取 provider 和 model
 */
export async function resolveClassifierModel(
  classifierConfig: ExpertRoutingConfig['classifier']
): Promise<ClassifierModelResult> {
  let provider;
  let model: string;

  if (classifierConfig.type === 'virtual') {
    const virtualModel = await modelDb.getById(classifierConfig.model_id!);
    if (!virtualModel) {
      throw new Error(
        `Classifier virtual model not found: ${classifierConfig.model_id}`
      );
    }

    if (virtualModel.routing_config_id) {
      const routingConfig = await routingConfigDb.getById(virtualModel.routing_config_id);
      if (!routingConfig) {
        throw new Error(
          `Routing config not found for classifier virtual model: ${virtualModel.routing_config_id}`
        );
      }

      try {
        const config = JSON.parse(routingConfig.config);
        // We need to dynamically import routing to avoid circular deps if routing imports this
        // But here we are in a sub-service.
        // The original code imported '../routes/proxy/routing.js'
        // We should probably check if that is safe. 
        // Assuming path is correct relative to this file:
        // packages/backend/src/routes/proxy/routing.js
        const { selectRoutingTarget } = await import('../../routes/proxy/routing.js');

        const selectedTarget = selectRoutingTarget(config, routingConfig.type, virtualModel.routing_config_id);

        if (!selectedTarget) {
          throw new Error(
            `No available target in routing config for classifier virtual model "${virtualModel.name}"`
          );
        }

        provider = await providerDb.getById(selectedTarget.provider);
        if (!provider) {
          throw new Error(
            `Provider not found for routing target: ${selectedTarget.provider}`
          );
        }

        model = selectedTarget.override_params?.model || virtualModel.model_identifier;
      } catch (e: any) {
        throw new Error(
          `Failed to resolve routing config for classifier virtual model "${virtualModel.name}": ${e.message}`
        );
      }
    } else if (virtualModel.expert_routing_id) {
      throw new Error(
        `Classifier virtual model "${virtualModel.name}" uses expert routing. ` +
        `Expert routing models cannot be directly resolved as classifiers - they need to be resolved through the routing chain.`
      );
    } else if (virtualModel.provider_id) {
      provider = await providerDb.getById(virtualModel.provider_id);
      if (!provider) {
        throw new Error(`Classifier provider not found for virtual model: ${virtualModel.provider_id}`);
      }
      model = virtualModel.model_identifier;
    } else {
      throw new Error(
        `Classifier virtual model "${virtualModel.name}" (${classifierConfig.model_id}) has no provider or routing configured. ` +
        `Please configure a provider, smart routing, or expert routing for this model.`
      );
    }
  } else {
    provider = await providerDb.getById(classifierConfig.provider_id!);
    if (!provider) {
      throw new Error('Classifier provider not found');
    }
    if (!classifierConfig.model) {
      throw new Error('Classifier model not specified');
    }
    model = classifierConfig.model;
  }

  return { provider, model };
}

/**
 * 解析专家/降级模型配置
 */
export async function resolveModelConfig(
  config: { type: 'virtual' | 'real'; model_id?: string; provider_id?: string; model?: string },
  configType: string
): Promise<ResolvedModel> {
  let provider;
  let modelOverride;
  let expertType: 'virtual' | 'real' = config.type;
  let expertName: string;
  let expertModelId: string | undefined;

  if (config.type === 'virtual') {
    const virtualModel = await modelDb.getById(config.model_id!);
    if (!virtualModel) {
      throw new Error(`${configType} virtual model not found: ${config.model_id}`);
    }
    expertModelId = config.model_id;
    expertName = virtualModel.name;
  } else {
    provider = await providerDb.getById(config.provider_id!);
    if (!provider) {
      throw new Error(`${configType} provider not found: ${config.provider_id}`);
    }
    modelOverride = config.model;
    expertName = `${provider.name}/${config.model}`;
  }

  return {
    provider,
    providerId: config.provider_id,
    modelOverride,
    expertType,
    expertName,
    expertModelId,
  };
}

// Helper to match experts (from expert-router.ts selectExpert)
export function matchExpert(category: string, experts: ExpertTarget[]): ExpertTarget | null {
    const normalizedCategory = category.trim().toLowerCase();

    const exactMatch = experts.find(
      e => e.category.trim().toLowerCase() === normalizedCategory
    );

    if (exactMatch) return exactMatch;

    const partialMatch = experts.find(
      e => {
        const expertCategory = e.category.trim().toLowerCase();
        return normalizedCategory.includes(expertCategory) || expertCategory.includes(normalizedCategory);
      }
    );

    return partialMatch || null;
}
