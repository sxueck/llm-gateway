import { providerDb, modelDb, routingConfigDb, expertRoutingConfigDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { expertRouter } from '../../services/expert-router.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';

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
    mode: 'loadbalance' | 'fallback' | 'hash' | 'affinity';
    // hash模式：使用哪个字段作为哈希key
    hashSource?: 'virtualKey' | 'request';
    // affinity模式：亲和性持续时间（毫秒），默认5分钟
    affinityTTL?: number;
  };
  targets: RoutingTarget[];
}

export interface ResolveProviderResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
  resolvedModel?: any;
  excludeProviders?: Set<string>;
}

export interface ProxyRequest {
  body: any;
  protocol?: 'openai' | 'anthropic';
}

const routingTargetIndexMap = new Map<string, number>();

// Affinity模式：存储每个config的当前选中provider和时间戳
interface AffinityState {
  providerId: string;
  timestamp: number;
}
const affinityStateMap = new Map<string, AffinityState>();

// 定期清理过期的affinity状态（每小时执行一次）
const AFFINITY_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1小时
const MAX_AFFINITY_AGE = 24 * 60 * 60 * 1000; // 24小时

setInterval(() => {
  const now = Date.now();
  const expiredKeys: string[] = [];
  
  for (const [key, state] of affinityStateMap.entries()) {
    if (now - state.timestamp > MAX_AFFINITY_AGE) {
      expiredKeys.push(key);
    }
  }
  
  if (expiredKeys.length > 0) {
    expiredKeys.forEach(key => affinityStateMap.delete(key));
    memoryLogger.info(
      `清理了 ${expiredKeys.length} 个过期的 affinity 状态`,
      'Routing'
    );
  }
}, AFFINITY_CLEANUP_INTERVAL);

// 简单的字符串哈希函数
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// 判断是否应该对智能路由进行重试
export function shouldRetrySmartRouting(statusCode: number): boolean {
  // 对于 400, 404, 429 (rate limit), 500, 502, 503, 504 错误进行重试
  return (
    statusCode === 400 ||
    statusCode === 404 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}

export function selectRoutingTarget(
  config: RoutingConfig,
  type: string,
  configId?: string,
  hashKey?: string,
  excludeProviders?: Set<string>
): RoutingTarget | null {
  if (!config.targets || config.targets.length === 0) {
    return null;
  }

  const availableTargets = config.targets.filter(t =>
    circuitBreaker.isAvailable(t.provider) &&
    (!excludeProviders || !excludeProviders.has(t.provider))
  );

  if (availableTargets.length === 0) {
    memoryLogger.warn(
      `所有路由目标均不可用 | total: ${config.targets.length}` +
      (excludeProviders ? ` | 已排除: ${excludeProviders.size}` : ''),
      'Routing'
    );
    return null;
  }

  if (type === 'loadbalance' || config.strategy?.mode === 'loadbalance') {
    const weightedTargets = availableTargets.filter(t => t.weight && t.weight > 0);
    if (weightedTargets.length === 0) {
      return availableTargets[0];
    }

    const totalWeight = weightedTargets.reduce((sum, t) => sum + (t.weight || 0), 0);
    let random = Math.random() * totalWeight;

    for (const target of weightedTargets) {
      random -= target.weight || 0;
      if (random <= 0) {
        return target;
      }
    }

    return weightedTargets[0];
  }

  if (type === 'fallback' || config.strategy?.mode === 'fallback') {
    if (!configId) {
      return availableTargets[0];
    }

    for (let i = 0; i < config.targets.length; i++) {
      const currentIndex = routingTargetIndexMap.get(configId) || 0;
      const target = config.targets[currentIndex];

      const nextIndex = (currentIndex + 1) % config.targets.length;
      routingTargetIndexMap.set(configId, nextIndex);

      if (circuitBreaker.isAvailable(target.provider)) {
        return target;
      }
    }

    return null;
  }

  // Hash模式：基于哈希key进行一致性哈希分配
  if (type === 'hash' || config.strategy?.mode === 'hash') {
    if (!hashKey) {
      memoryLogger.warn('Hash模式需要提供hashKey，降级为随机选择', 'Routing');
      return availableTargets[0];
    }

    const weightedTargets = availableTargets.filter(t => t.weight && t.weight > 0);
    const targetsToUse = weightedTargets.length > 0 ? weightedTargets : availableTargets;

    // 计算总权重
    const totalWeight = targetsToUse.reduce((sum, t) => sum + (t.weight || 1), 0);

    // 使用哈希值对总权重取模，得到一个位置
    const hash = simpleHash(hashKey);
    let position = hash % totalWeight;

    // 根据权重找到对应的target
    for (const target of targetsToUse) {
      const weight = target.weight || 1;
      if (position < weight) {
        memoryLogger.debug(
          `Hash路由: hashKey=${hashKey.substring(0, 8)}... -> provider=${target.provider}`,
          'Routing'
        );
        return target;
      }
      position -= weight;
    }

    return targetsToUse[0];
  }

  // Affinity模式：在短时间内优先使用同一个provider
  if (type === 'affinity' || config.strategy?.mode === 'affinity') {
    if (!configId) {
      return availableTargets[0];
    }

    const ttl = config.strategy?.affinityTTL || 5 * 60 * 1000; // 默认5分钟
    const now = Date.now();
    const state = affinityStateMap.get(configId);

    // 检查是否有有效的affinity状态
    if (state && (now - state.timestamp) < ttl) {
      // 检查当前选中的provider是否仍然可用
      const currentTarget = availableTargets.find(t => t.provider === state.providerId);
      if (currentTarget) {
        memoryLogger.debug(
          `Affinity路由: 使用缓存的provider=${state.providerId} (剩余${Math.floor((ttl - (now - state.timestamp)) / 1000)}秒)`,
          'Routing'
        );
        return currentTarget;
      }

      memoryLogger.info(
        `Affinity路由: 缓存的provider=${state.providerId}不可用，重新选择`,
        'Routing'
      );
    }

    // 需要选择新的provider（基于权重）
    const weightedTargets = availableTargets.filter(t => t.weight && t.weight > 0);
    let selectedTarget: RoutingTarget;

    if (weightedTargets.length > 0) {
      const totalWeight = weightedTargets.reduce((sum, t) => sum + (t.weight || 0), 0);
      let random = Math.random() * totalWeight;

      selectedTarget = weightedTargets[0];
      for (const target of weightedTargets) {
        random -= target.weight || 0;
        if (random <= 0) {
          selectedTarget = target;
          break;
        }
      }
    } else {
      selectedTarget = availableTargets[0];
    }

    // 更新affinity状态
    affinityStateMap.set(configId, {
      providerId: selectedTarget.provider,
      timestamp: now
    });

    memoryLogger.info(
      `Affinity路由: 选择新provider=${selectedTarget.provider} (TTL=${ttl / 1000}秒)`,
      'Routing'
    );

    return selectedTarget;
  }

  return availableTargets[0];
}

export async function resolveSmartRouting(
  model: any,
  request?: ProxyRequest,
  virtualKeyId?: string,
  excludeProviders?: Set<string>
): Promise<ResolveProviderResult | null> {
  if (model.is_virtual !== 1 || !model.routing_config_id) {
    return null;
  }

  const routingConfig = await routingConfigDb.getById(model.routing_config_id);
  if (!routingConfig) {
    memoryLogger.error(`Smart routing config not found: ${model.routing_config_id}`, 'Proxy');
    throw new Error('Smart routing config not found');
  }

  try {
    const config = JSON.parse(routingConfig.config);

    // 根据配置决定使用什么作为hash key
    let hashKey: string | undefined;
    if (config.strategy?.mode === 'hash') {
      const hashSource = config.strategy?.hashSource || 'virtualKey';
      if (hashSource === 'virtualKey' && virtualKeyId) {
        hashKey = virtualKeyId;
      } else if (hashSource === 'request' && request?.body) {
        // 使用请求体的哈希作为key
        hashKey = JSON.stringify(request.body);
      }
    }

    const selectedTarget = selectRoutingTarget(
      config,
      routingConfig.type,
      model.routing_config_id,
      hashKey,
      excludeProviders
    );

    if (!selectedTarget) {
      memoryLogger.error(`No target selected from smart routing config: ${model.routing_config_id}`, 'Proxy');
      throw new Error('No available target in smart routing config');
    }

    const provider = await providerDb.getById(selectedTarget.provider);
    if (!provider) {
      memoryLogger.error(`Smart routing target provider not found: ${selectedTarget.provider}`, 'Proxy');
      throw new Error('Smart routing target provider not found');
    }

    // 初始化或更新 excludeProviders
    const updatedExcludeProviders = excludeProviders || new Set<string>();
    updatedExcludeProviders.add(selectedTarget.provider);

    const result: ResolveProviderResult = {
      provider,
      providerId: selectedTarget.provider,
      excludeProviders: updatedExcludeProviders
    };

    // 查找真实模型配置（用于获取 protocol）
    let resolvedModel: any = null;
    if (selectedTarget.override_params?.model) {
      result.modelOverride = selectedTarget.override_params.model;

      // 从 provider 下查找匹配的真实模型
      const providerModels = await modelDb.getByProviderId(selectedTarget.provider);
      resolvedModel = providerModels.find(m =>
        m.is_virtual !== 1 && (
          m.model_identifier === selectedTarget.override_params!.model ||
          m.name === selectedTarget.override_params!.model
        )
      );

      if (resolvedModel) {
        result.resolvedModel = resolvedModel;
        memoryLogger.debug(
          `Smart routing resolved real model: ${resolvedModel.name} | protocol: ${resolvedModel.protocol || 'auto'}`,
          'Routing'
        );
      } else {
        memoryLogger.warn(
          `Smart routing could not find real model for: ${selectedTarget.override_params.model} in provider: ${provider.name}`,
          'Routing'
        );
      }

      memoryLogger.debug(
        `Smart routing model override: ${selectedTarget.override_params.model}`,
        'Proxy'
      );
    }

    memoryLogger.info(
      `Smart routing target selected: provider=${provider.name} | model=${selectedTarget.override_params?.model || 'default'} | protocol=${resolvedModel?.protocol || 'auto'}`,
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

  const expertRoutingConfig = await expertRoutingConfigDb.getById(model.expert_routing_id);
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
      const virtualModel = await modelDb.getById(result.expertModelId!);
      if (!virtualModel) {
        throw new Error(`Virtual model not found: ${result.expertModelId}`);
      }

      memoryLogger.debug(
        `专家路由递归解析虚拟模型: ${virtualModel.name}`,
        'ExpertRouter'
      );

      const resolvedResult = await resolveProviderFromModel(virtualModel, request, virtualKeyId, depth + 1);

      if (resolvedResult.resolvedModel) {
        memoryLogger.debug(
          `专家路由最终解析模型: ${resolvedResult.resolvedModel.name} | protocol: ${resolvedResult.resolvedModel.protocol || 'auto'}`,
          'ExpertRouter'
        );
      }

      return resolvedResult;
    }

    if (result.modelOverride) {
      request.body = request.body || {};
      request.body.model = result.modelOverride;
    }

    // 对于 real 类型的专家，尝试获取模型信息
    let resolvedModel;
    if (result.expertType === 'real' && result.providerId && result.modelOverride) {
      // 从 provider 下查找匹配的真实模型（类似智能路由的处理）
      const providerModels = await modelDb.getByProviderId(result.providerId);
      resolvedModel = providerModels.find(m =>
        m.is_virtual !== 1 && (
          m.model_identifier === result.modelOverride ||
          m.name === result.modelOverride
        )
      );

      if (resolvedModel) {
        memoryLogger.debug(
          `专家路由解析真实模型: ${resolvedModel.name} | protocol: ${resolvedModel.protocol || 'auto'}`,
          'ExpertRouter'
        );
      } else {
        memoryLogger.warn(
          `专家路由未找到真实模型: ${result.modelOverride} in provider: ${result.providerId}`,
          'ExpertRouter'
        );
      }
    } else if (result.expert.model_id) {
      resolvedModel = await modelDb.getById(result.expert.model_id);
    }

    return {
      provider: result.provider,
      providerId: result.providerId,
      modelOverride: result.modelOverride,
      resolvedModel
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

  // 自动设置协议标记（如果尚未设置）
  if (!request.protocol) {
    request.protocol = 'openai'; // 默认为 OpenAI 协议
  }

  if (model.expert_routing_id) {
    const expertRoutingResult = await resolveExpertRouting(model, request, virtualKeyId, depth);
    if (expertRoutingResult) {
      return expertRoutingResult;
    }
  }

  const smartRoutingResult = await resolveSmartRouting(model, request, virtualKeyId);
  if (smartRoutingResult) {
    if (smartRoutingResult.modelOverride) {
      request.body = request.body || {};
      request.body.model = smartRoutingResult.modelOverride;
    }
    return {
      provider: smartRoutingResult.provider,
      providerId: smartRoutingResult.providerId,
      excludeProviders: smartRoutingResult.excludeProviders,
      resolvedModel: smartRoutingResult.resolvedModel
    };
  }

  if (!model.provider_id) {
    throw new Error('Model has no provider configured');
  }

  const provider = await providerDb.getById(model.provider_id);
  if (!provider) {
    memoryLogger.error(`Provider not found: ${model.provider_id}`, 'Proxy');
    throw new Error('Provider config not found');
  }

  return {
    provider,
    providerId: model.provider_id
  };
}
