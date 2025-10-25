import { providerDb, modelDb, routingConfigDb, expertRoutingConfigDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { expertRouter } from '../../services/expert-router.js';

export interface RoutingTarget {
  provider: string;
  weight?: number;
  override_params?: {
    model?: string;
    [key: string]: any;
  };
  on_status_codes?: number[];
}

export interface RoutingConfig {
  strategy: {
    mode: 'loadbalance' | 'fallback';
  };
  targets: RoutingTarget[];
}

export interface ResolveProviderResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
}

export interface ProxyRequest {
  body: any;
}

const routingTargetIndexMap = new Map<string, number>();

export function selectRoutingTarget(config: RoutingConfig, type: string, configId?: string): RoutingTarget | null {
  if (!config.targets || config.targets.length === 0) {
    return null;
  }

  if (type === 'loadbalance' || config.strategy?.mode === 'loadbalance') {
    const targets = config.targets.filter(t => t.weight && t.weight > 0);
    if (targets.length === 0) {
      return config.targets[0];
    }

    const totalWeight = targets.reduce((sum, t) => sum + (t.weight || 0), 0);
    let random = Math.random() * totalWeight;

    for (const target of targets) {
      random -= target.weight || 0;
      if (random <= 0) {
        return target;
      }
    }

    return targets[0];
  }

  if (type === 'fallback' || config.strategy?.mode === 'fallback') {
    if (!configId) {
      return config.targets[0];
    }

    const currentIndex = routingTargetIndexMap.get(configId) || 0;
    const nextIndex = (currentIndex + 1) % config.targets.length;
    routingTargetIndexMap.set(configId, nextIndex);
    return config.targets[nextIndex];
  }

  return config.targets[0];
}

export function resolveSmartRouting(model: any): ResolveProviderResult | null {
  if (model.is_virtual !== 1 || !model.routing_config_id) {
    return null;
  }

  const routingConfig = routingConfigDb.getById(model.routing_config_id);
  if (!routingConfig) {
    memoryLogger.error(`Smart routing config not found: ${model.routing_config_id}`, 'Proxy');
    throw new Error('Smart routing config not found');
  }

  try {
    const config = JSON.parse(routingConfig.config);
    const selectedTarget = selectRoutingTarget(config, routingConfig.type, model.routing_config_id);

    if (!selectedTarget) {
      memoryLogger.error(`No target selected from smart routing config: ${model.routing_config_id}`, 'Proxy');
      throw new Error('No available target in smart routing config');
    }

    const provider = providerDb.getById(selectedTarget.provider);
    if (!provider) {
      memoryLogger.error(`Smart routing target provider not found: ${selectedTarget.provider}`, 'Proxy');
      throw new Error('Smart routing target provider not found');
    }

    const result: ResolveProviderResult = {
      provider,
      providerId: selectedTarget.provider
    };

    if (selectedTarget.override_params?.model) {
      result.modelOverride = selectedTarget.override_params.model;
      memoryLogger.debug(
        `Smart routing model override: ${selectedTarget.override_params.model}`,
        'Proxy'
      );
    }

    memoryLogger.info(
      `Smart routing target selected: provider=${provider.name} | model=${selectedTarget.override_params?.model || 'default'}`,
      'Proxy'
    );

    return result;
  } catch (e: any) {
    memoryLogger.error(`Failed to parse smart routing config: ${e.message}`, 'Proxy');
    throw new Error(`Smart routing config parse error: ${e.message}`);
  }
}

export async function resolveExpertRouting(
  model: any,
  request: ProxyRequest,
  virtualKeyId?: string,
  depth: number = 0
): Promise<ResolveProviderResult | null> {
  if (!model.expert_routing_id) {
    return null;
  }

  const expertRoutingConfig = expertRoutingConfigDb.getById(model.expert_routing_id);
  if (!expertRoutingConfig || expertRoutingConfig.enabled !== 1) {
    memoryLogger.warn(
      `专家路由配置未找到或未启用: ${model.expert_routing_id}`,
      'ExpertRouter'
    );
    return null;
  }

  try {
    const result = await expertRouter.route(request, model.expert_routing_id, {
      modelId: model.id,
      virtualKeyId: virtualKeyId
    });

    memoryLogger.info(
      `专家路由: 分类=${result.category} | 专家类型=${result.expertType} | 专家=${result.expertName}`,
      'ExpertRouter'
    );

    if (result.expertType === 'virtual') {
      const virtualModel = modelDb.getById(result.expertModelId!);
      if (!virtualModel) {
        throw new Error(`Virtual model not found: ${result.expertModelId}`);
      }

      return await resolveProviderFromModel(virtualModel, request, virtualKeyId, depth + 1);
    }

    if (result.modelOverride) {
      request.body = request.body || {};
      request.body.model = result.modelOverride;
    }

    return {
      provider: result.provider,
      providerId: result.providerId,
      modelOverride: result.modelOverride
    };

  } catch (e: any) {
    memoryLogger.error(`专家路由失败: ${e.message}`, 'ExpertRouter');
    throw new Error(`Expert routing failed: ${e.message}`);
  }
}

export async function resolveProviderFromModel(
  model: any,
  request: ProxyRequest,
  virtualKeyId?: string,
  depth: number = 0
): Promise<ResolveProviderResult> {
  if (depth > 5) {
    throw new Error('Maximum routing depth exceeded (possible circular reference)');
  }

  if (model.expert_routing_id) {
    const expertRoutingResult = await resolveExpertRouting(model, request, virtualKeyId, depth);
    if (expertRoutingResult) {
      return expertRoutingResult;
    }
  }

  const smartRoutingResult = resolveSmartRouting(model);
  if (smartRoutingResult) {
    if (smartRoutingResult.modelOverride) {
      request.body = request.body || {};
      request.body.model = smartRoutingResult.modelOverride;
    }
    return {
      provider: smartRoutingResult.provider,
      providerId: smartRoutingResult.providerId
    };
  }

  if (!model.provider_id) {
    throw new Error('Model has no provider configured');
  }

  const provider = providerDb.getById(model.provider_id);
  if (!provider) {
    memoryLogger.error(`Provider not found: ${model.provider_id}`, 'Proxy');
    throw new Error('Provider config not found');
  }

  return {
    provider,
    providerId: model.provider_id
  };
}

