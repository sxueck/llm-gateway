import { providerDb, modelDb, routingConfigDb, expertRoutingConfigDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { expertRouter } from '../../services/expert-router.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import { parsePositiveInt } from '../../utils/parse-positive-int.js';

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
  circuitBreakerKey?: string;
  modelOverride?: string;
  resolvedModel?: any;
  excludeTargetKeys?: Set<string>;
  canRetry?: boolean;
}

export interface ProxyRequest {
  body: any;
  protocol?: 'openai' | 'anthropic';
  headers?: Record<string, any>;
}

interface AffinityState {
  targetKey: string;
  providerId: string;
  timestamp: number;
  kind: 'explicit' | 'anonymous';
  expiresAt: number;
}

const DEFAULT_MAX_AFFINITY_STATE_ENTRIES = 20000;
const DEFAULT_MAX_LOAD_BALANCE_CURSOR_ENTRIES = 10000;
const DEFAULT_EXPLICIT_AFFINITY_IDLE_TTL_MS = 60 * 60 * 1000;

const MAX_AFFINITY_STATE_ENTRIES = parsePositiveInt(
  process.env.MAX_AFFINITY_STATE_ENTRIES,
  DEFAULT_MAX_AFFINITY_STATE_ENTRIES
);

const MAX_LOAD_BALANCE_CURSOR_ENTRIES = parsePositiveInt(
  process.env.MAX_LOAD_BALANCE_CURSOR_ENTRIES,
  DEFAULT_MAX_LOAD_BALANCE_CURSOR_ENTRIES
);

const EXPLICIT_AFFINITY_IDLE_TTL_MS = parsePositiveInt(
  process.env.EXPLICIT_AFFINITY_IDLE_TTL_MS,
  DEFAULT_EXPLICIT_AFFINITY_IDLE_TTL_MS
);

const affinityStateMap = new Map<string, AffinityState>();
const loadBalanceCursorMap = new Map<string, number>();

function evictOldestEntries<T>(targetMap: Map<string, T>, maxEntries: number): number {
  let removedCount = 0;

  while (targetMap.size > maxEntries) {
    const oldestEntryKey = targetMap.keys().next().value as string | undefined;
    if (!oldestEntryKey) {
      break;
    }

    targetMap.delete(oldestEntryKey);
    removedCount++;
  }

  return removedCount;
}

function setMapValueWithCapacity<T>(
  targetMap: Map<string, T>,
  key: string,
  value: T,
  maxEntries: number
): void {
  if (targetMap.has(key)) {
    targetMap.delete(key);
  }

  targetMap.set(key, value);
  evictOldestEntries(targetMap, maxEntries);
}

export function getTargetKey(target: RoutingTarget): string {
  const overrideModel = target.override_params?.model?.trim();
  if (!overrideModel) {
    return target.provider;
  }

  return `${target.provider}::${overrideModel}`;
}

function buildLoadBalanceStateKey(config: RoutingConfig, configId?: string): string {
  if (configId) {
    return configId;
  }

  return config.targets.map(getTargetKey).join('|');
}

function selectRoundRobinTarget(
  availableTargets: RoutingTarget[],
  config: RoutingConfig,
  configId?: string
): RoutingTarget {
  const stateKey = buildLoadBalanceStateKey(config, configId);
  const cursor = loadBalanceCursorMap.get(stateKey) || 0;
  const availableTargetSet = new Set(availableTargets);

  for (let offset = 0; offset < config.targets.length; offset++) {
    const targetIndex = (cursor + offset) % config.targets.length;
    const candidateTarget = config.targets[targetIndex];

    if (!candidateTarget || !availableTargetSet.has(candidateTarget)) {
      continue;
    }

    setMapValueWithCapacity(
      loadBalanceCursorMap,
      stateKey,
      (targetIndex + 1) % config.targets.length,
      MAX_LOAD_BALANCE_CURSOR_ENTRIES
    );
    return candidateTarget;
  }

  // selectRoutingTarget 已保证至少存在一个可用目标，这里仅作防御性兜底。
  return availableTargets[0];
}

function sortTargetsByWeightDesc(targets: RoutingTarget[]): RoutingTarget[] {
  return [...targets].sort((left, right) => (right.weight || 0) - (left.weight || 0));
}

function selectWeightedRandomTarget(weightedTargets: RoutingTarget[]): RoutingTarget {
  const totalWeight = weightedTargets.reduce((sum, target) => sum + (target.weight || 0), 0);
  let random = Math.random() * totalWeight;

  for (const target of weightedTargets) {
    random -= target.weight || 0;
    if (random <= 0) {
      return target;
    }
  }

  return weightedTargets[0]!;
}

function selectFailoverTarget(availableTargets: RoutingTarget[]): RoutingTarget {
  const weightedTargets = availableTargets.filter(target => (target.weight || 0) > 0);
  if (weightedTargets.length > 0) {
    return sortTargetsByWeightDesc(weightedTargets)[0]!;
  }

  return availableTargets[0]!;
}

export function hasAvailableRoutingTargets(
  config: RoutingConfig,
  excludeTargetKeys?: Set<string>
): boolean {
  return config.targets.some(target =>
    (!excludeTargetKeys || !excludeTargetKeys.has(getTargetKey(target))) &&
    circuitBreaker.peekAvailability(getTargetKey(target))
  );
}

function normalizeAffinityScopeKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  return v.length > 256 ? v.slice(0, 256) : v;
}

function buildAffinityCacheKey(configId: string, affinityScopeKey: string): string {
  return `${configId}:${affinityScopeKey}`;
}

function buildAnonymousAffinityCacheKey(configId: string): string {
  return `${configId}:__anonymous__`;
}

export function getAnonymousAffinityTargetKey(configId: string): string | null {
  const cacheKey = buildAnonymousAffinityCacheKey(configId);
  const state = affinityStateMap.get(cacheKey);
  if (!state) return null;
  if (Date.now() >= state.expiresAt) {
    affinityStateMap.delete(cacheKey);
    return null;
  }
  return state.targetKey;
}

export function countExplicitSessionBindings(configId: string, targetKey: string): number {
  const anonymousKey = buildAnonymousAffinityCacheKey(configId);
  const prefix = `${configId}:`;
  let count = 0;
  const now = Date.now();
  for (const [key, state] of affinityStateMap.entries()) {
    if (key.startsWith(prefix) && key !== anonymousKey) {
      if (state.targetKey === targetKey && now < state.expiresAt) {
        count++;
      }
    }
  }
  return count;
}

function extractAffinityScopeKey(request?: any): string | undefined {
  const headers: Record<string, any> = (request?.headers as any) || {};
  const body: any = request?.body || {};

  const header = (name: string): unknown => headers[name] ?? headers[name.toLowerCase()];

  const candidates: unknown[] = [
    header('x-session-id'),
    header('x-session-affinity'),
    body?.session_id,
    body?.sessionId,
    body?.metadata?.session_id,
    body?.metadata?.sessionId,
  ];

  for (const c of candidates) {
    const normalized = normalizeAffinityScopeKey(c);
    if (normalized) return normalized;
  }
  return undefined;
}

function selectLoadBalanceTarget(
  availableTargets: RoutingTarget[],
  config: RoutingConfig,
  configId?: string,
  excludeTargetKeys?: Set<string>
): RoutingTarget {
  const weightedTargets = availableTargets.filter(t => t.weight && t.weight > 0);
  if (weightedTargets.length === 0) {
    return selectRoundRobinTarget(availableTargets, config, configId);
  }

  if (excludeTargetKeys && excludeTargetKeys.size > 0) {
    return selectFailoverTarget(availableTargets);
  }

  return selectWeightedRandomTarget(weightedTargets);
}

// 定期清理已过期的 affinity 状态。
const AFFINITY_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1小时

const affinityCleanupTimer = setInterval(() => {
  const now = Date.now();
  const expiredKeys: string[] = [];
  
  for (const [key, state] of affinityStateMap.entries()) {
    if (now >= state.expiresAt) {
      expiredKeys.push(key);
    }
  }
  
  if (expiredKeys.length > 0) {
    expiredKeys.forEach(key => affinityStateMap.delete(key));
    memoryLogger.info(
      `清理了 ${expiredKeys.length} 个已过期的 affinity 状态`,
      'Routing'
    );
  }

  const removedOverflowCount = evictOldestEntries(affinityStateMap, MAX_AFFINITY_STATE_ENTRIES);
  if (removedOverflowCount > 0) {
    memoryLogger.warn(
      `affinity 状态超过上限 ${MAX_AFFINITY_STATE_ENTRIES}，已额外清理 ${removedOverflowCount} 条`,
      'Routing'
    );
  }

  const removedCursorOverflowCount = evictOldestEntries(
    loadBalanceCursorMap,
    MAX_LOAD_BALANCE_CURSOR_ENTRIES
  );
  if (removedCursorOverflowCount > 0) {
    memoryLogger.warn(
      `loadbalance 游标状态超过上限 ${MAX_LOAD_BALANCE_CURSOR_ENTRIES}，已清理 ${removedCursorOverflowCount} 条`,
      'Routing'
    );
  }
}, AFFINITY_CLEANUP_INTERVAL);

affinityCleanupTimer.unref?.();

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
  // 对于认证/权限错误、客户端错误、限流、自定义错误、服务器错误进行重试
  // 401: Unauthorized (认证失败，可能是 API Key 过期或无效)
  // 403: Forbidden (权限不足，可能是配额耗尽或 IP 限制)
  // 400: Bad Request (请求格式错误)
  // 404: Not Found (模型不存在)
  // 429: Rate Limit (限流)
  // 472: Upstream Custom (自定义上游错误)
  // 500/502/503/504: Server Errors (服务器错误)
  return (
    statusCode === 401 ||
    statusCode === 403 ||
    statusCode === 400 ||
    statusCode === 404 ||
    statusCode === 429 ||
    statusCode === 472 ||
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
  excludeTargetKeys?: Set<string>
): RoutingTarget | null {
  if (!config.targets || config.targets.length === 0) {
    return null;
  }

  const availableTargets = config.targets.filter(t =>
    (!excludeTargetKeys || !excludeTargetKeys.has(getTargetKey(t))) &&
    circuitBreaker.isAvailable(getTargetKey(t))
  );

  // 记录经过熔断和排除过滤后的可用 targets
  if (availableTargets.length > 0) {
    const availableInfo = availableTargets.map((t, idx) =>
      `[${idx}] provider=${t.provider}, model=${t.override_params?.model || 'default'}, weight=${t.weight || 0}, key=${getTargetKey(t)}`
    ).join('; ');
    memoryLogger.info(
      `Smart routing available targets after filter | mode=${type} | count=${availableTargets.length} | targets=[${availableInfo}]`,
      'Routing'
    );
  }

  if (availableTargets.length === 0) {
    memoryLogger.warn(
      `所有路由目标均不可用 | total: ${config.targets.length}` +
      (excludeTargetKeys ? ` | 已排除: ${excludeTargetKeys.size}` : ''),
      'Routing'
    );
    return null;
  }

  if (type === 'loadbalance' || config.strategy?.mode === 'loadbalance') {
    return selectLoadBalanceTarget(availableTargets, config, configId, excludeTargetKeys);
  }

  if (type === 'fallback' || config.strategy?.mode === 'fallback') {
    return availableTargets[0] || null;
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

  // Affinity模式：显式 session 在活跃期间保持亲和；无显式 session 时按配置的 affinityTTL 做绝对粘性。
  if (type === 'affinity' || config.strategy?.mode === 'affinity') {
    if (!configId) {
      return selectLoadBalanceTarget(availableTargets, config, configId, excludeTargetKeys);
    }

    const ttl = config.strategy?.affinityTTL || 5 * 60 * 1000;
    const now = Date.now();
    const affinityScopeKey = normalizeAffinityScopeKey(hashKey);
    const hasExplicitSession = !!affinityScopeKey;
    const affinityCacheKey = hasExplicitSession
      ? buildAffinityCacheKey(String(configId), affinityScopeKey)
      : buildAnonymousAffinityCacheKey(String(configId));
    const state = affinityStateMap.get(affinityCacheKey);

    if (state) {
      const currentTarget = availableTargets.find(t => getTargetKey(t) === state.targetKey);
      if (currentTarget) {
        if (state.kind === 'explicit') {
          if (now >= state.expiresAt) {
            affinityStateMap.delete(affinityCacheKey);
          } else {
            setMapValueWithCapacity(
              affinityStateMap,
              affinityCacheKey,
              { ...state, timestamp: now, expiresAt: now + EXPLICIT_AFFINITY_IDLE_TTL_MS },
              MAX_AFFINITY_STATE_ENTRIES
            );
            return currentTarget;
          }
        }

        if (now < state.expiresAt) {
          return currentTarget;
        }
      }

      affinityStateMap.delete(affinityCacheKey);
      memoryLogger.debug(
        `Affinity路由: ${state.kind === 'explicit' ? '显式 session' : '匿名粘性'} 绑定的 target=${state.targetKey} ${currentTarget ? '已过期' : '不可用'}，重新选择`,
        'Routing'
      );
    }

    const selectedTarget = selectLoadBalanceTarget(availableTargets, config, configId, excludeTargetKeys);

    const nextState: AffinityState = {
      targetKey: getTargetKey(selectedTarget),
      providerId: selectedTarget.provider,
      timestamp: now,
      kind: hasExplicitSession ? 'explicit' : 'anonymous',
      expiresAt: now + (hasExplicitSession ? EXPLICIT_AFFINITY_IDLE_TTL_MS : ttl)
    };

    setMapValueWithCapacity(affinityStateMap, affinityCacheKey, nextState, MAX_AFFINITY_STATE_ENTRIES);

    memoryLogger.info(
      `Affinity路由: ${hasExplicitSession ? `显式 session 绑定` : `匿名粘性选择`} target=${getTargetKey(selectedTarget)}，TTL=${Math.floor((hasExplicitSession ? EXPLICIT_AFFINITY_IDLE_TTL_MS : ttl) / 1000)}秒`,
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
  excludeTargetKeys?: Set<string>
): Promise<ResolveProviderResult | null> {
  if (model.is_virtual !== 1 || !model.routing_config_id) {
    return null;
  }

  const routingConfig = await routingConfigDb.getById(model.routing_config_id);
  if (!routingConfig) {
    memoryLogger.error(`Smart routing config not found: ${model.routing_config_id}`, 'Proxy');
    throw new Error('Smart routing config not found');
  }

  let config: RoutingConfig;
  try {
    config = JSON.parse(routingConfig.config);
  } catch (e: any) {
    memoryLogger.error(`Failed to parse smart routing config: ${e.message}`, 'Proxy');
    throw new Error(`Smart routing config parse error: ${e.message}`);
  }

  const mode: RoutingConfig['strategy']['mode'] = (config.strategy?.mode || routingConfig.type) as any;

  // 记录所有配置的 targets（原始列表）
  if (config.targets && config.targets.length > 0) {
    const targetsInfo = config.targets.map((t, idx) => {
      const targetKey = getTargetKey(t);
      const isAvailable = circuitBreaker.peekAvailability(targetKey);
      const isExcluded = excludeTargetKeys?.has(targetKey);
      return `[${idx}] provider=${t.provider}, model=${t.override_params?.model || 'default'}, weight=${t.weight || 0}, key=${targetKey}, available=${isAvailable}${isExcluded ? ', excluded' : ''}`;
    }).join('; ');
    memoryLogger.info(
      `Smart routing targets config | mode=${mode} | total=${config.targets.length} | targets=[${targetsInfo}]`,
      'Routing'
    );
  }

  let routingKey: string | undefined;
  if (mode === 'hash') {
    const hashSource = config.strategy?.hashSource || 'virtualKey';
    if (hashSource === 'virtualKey' && virtualKeyId) {
      routingKey = virtualKeyId;
    } else if (hashSource === 'request' && request?.body) {
      // 使用请求体的哈希作为key
      routingKey = JSON.stringify(request.body);
    }
  } else if (mode === 'affinity') {
    routingKey = extractAffinityScopeKey(request as any);
  }

  // 记录当前路由配置是否存在 targets，用于后续区分配置问题 vs. 熔断/负载问题
  const hasTargets = Array.isArray(config.targets) && config.targets.length > 0;

  const selectedTarget = selectRoutingTarget(
    config,
    routingConfig.type,
    model.routing_config_id,
    routingKey,
    excludeTargetKeys
  );

  if (!selectedTarget) {
    if (!hasTargets) {
      memoryLogger.error(
        `Smart routing config has no targets: ${model.routing_config_id}`,
        'Proxy'
      );
      throw new Error('Smart routing config has no targets');
    }

    // 存在 targets 但没有可用目标，说明可能全部被熔断或在本次请求中轮转耗尽
    const error: any = new Error('当前上游负载忙，请稍后重试');
    error.statusCode = 503;
    error.code = 'upstream_overloaded';

    memoryLogger.warn(
      `Smart routing: all targets unavailable (possibly circuit breaker open) | config: ${model.routing_config_id}`,
      'Proxy'
    );

    throw error;
  }

  const provider = await providerDb.getById(selectedTarget.provider);
  if (!provider) {
    memoryLogger.error(`Smart routing target provider not found: ${selectedTarget.provider}`, 'Proxy');
    throw new Error('Smart routing target provider not found');
  }

  // 智能路由重试需要按 target key 排除，避免同一 provider 下的其他真实模型被误伤。
  const updatedExcludeTargetKeys = excludeTargetKeys || new Set<string>();
  updatedExcludeTargetKeys.add(getTargetKey(selectedTarget));

  const result: ResolveProviderResult = {
    provider,
    providerId: selectedTarget.provider,
    circuitBreakerKey: getTargetKey(selectedTarget),
    excludeTargetKeys: updatedExcludeTargetKeys,
    canRetry: hasAvailableRoutingTargets(config, updatedExcludeTargetKeys)
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
    `Smart routing target selected: provider=${provider.name} | providerId=${selectedTarget.provider} | model=${selectedTarget.override_params?.model || 'default'} | weight=${selectedTarget.weight || 0} | protocol=${resolvedModel?.protocol || 'auto'}${resolvedModel ? ` | resolvedModelId=${resolvedModel.id}` : ''}`,
    'Routing'
  );

  return result;
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

    if (result.enable_adaptive_thinking === true && result.thinking_enabled !== undefined) {
      request.body = request.body || {};
      const body = request.body;
      const hasExplicitThinking = body.thinking !== undefined;
      const hasExplicitReasoning = body.reasoning !== undefined;
      const hasExplicitReasoningEffort = body.reasoning_effort !== undefined;

      if (!hasExplicitThinking && !hasExplicitReasoning && !hasExplicitReasoningEffort) {
        const protocol = resolvedModel?.protocol || result.provider?.protocol;
        if (result.thinking_enabled === true) {
          if (protocol === 'anthropic') {
            body.thinking = { type: 'enabled', budget_tokens: 1024 };
            if (!body.max_tokens && !body.max_completion_tokens) {
              body.max_tokens = 4096;
            }
          } else {
            body.thinking = { type: 'enabled' };
          }
          memoryLogger.debug(`thinking=enabled (${protocol || 'auto'})`, 'ExpertRouter');
        } else {
          body.thinking = { type: 'disabled' };
          memoryLogger.debug(`thinking=disabled (${protocol || 'auto'})`, 'ExpertRouter');
        }
      }
    }

    return {
      provider: result.provider,
      providerId: result.providerId,
      circuitBreakerKey: result.providerId,
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
      circuitBreakerKey: smartRoutingResult.circuitBreakerKey,
      excludeTargetKeys: smartRoutingResult.excludeTargetKeys,
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
    providerId: model.provider_id,
    circuitBreakerKey: model.provider_id
  };
}
