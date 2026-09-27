import { FastifyRequest, FastifyReply } from 'fastify';
import { systemConfigDb, expertRoutingConfigDb, modelDb } from '../../db/index.js';
import { hotConfigCache } from '../../services/hot-config-cache.js';
import { memoryLogger } from '../../services/logger.js';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader, getModelIdsFromVirtualKey } from './auth.js';
import { resolveServingLimits } from '../../utils/serving-limits.js';

// Internal attribute keys that configure upstream transport, never meant for clients.
const INTERNAL_ATTRIBUTE_KEYS = new Set(['headers', 'timeout', 'maxRetries', 'requestTimeout', 'upstream_websocket_enabled']);

export function parseModelAttributes(modelAttributes: string | null | undefined): any {
  if (!modelAttributes) {
    return {};
  }

  try {
    return JSON.parse(modelAttributes);
  } catch (e) {
    return {};
  }
}

export function buildModelBaseInfo(model: any): any {
  return {
    id: model.is_virtual ? model.name : model.model_identifier,
    object: 'model',
    created: Math.floor(model.created_at / 1000),
    owned_by: 'system'
  };
}

/**
 * §5.10: tiered-routing models expose their tier membership in /v1/models
 * metadata so clients can display what each band contains. Best-effort — an
 * unreadable config simply omits the field.
 */
async function buildRoutingTiers(expertRoutingId: string): Promise<Record<string, string[]> | null> {
  try {
    const row = await expertRoutingConfigDb.getById(expertRoutingId);
    if (!row) return null;
    const experts = (JSON.parse(row.config) as any)?.experts;
    if (!Array.isArray(experts)) return null;
    const names = await Promise.all(
      (experts as any[]).map(async (expert) => {
        if (expert.model) return expert.model;
        if (expert.type === 'virtual' && expert.model_id) {
          const model = await modelDb.getById(expert.model_id);
          return model?.name || expert.id;
        }
        return expert.id;
      }),
    );
    const tiers: Record<string, string[]> = { low: [], medium: [], high: [] };
    experts.forEach((expert: any, index: number) => {
      if (expert.band === 'low' || expert.band === 'medium' || expert.band === 'high') {
        tiers[expert.band].push(names[index]);
      }
    });
    return tiers;
  } catch {
    return null;
  }
}

export function mergeModelAttributes(baseInfo: any, attributes: any): any {
  for (const [key, value] of Object.entries(attributes)) {
    if (key !== 'id' && key !== 'object' && key !== 'created' && key !== 'owned_by' && !INTERNAL_ATTRIBUTE_KEYS.has(key)) {
      baseInfo[key] = value;
    }
  }
  return baseInfo;
}

// Surface the model's serving limits (context window, real completion cap) as
// top-level /v1/models fields so clients can machine-read them. Catalog output
// values (max_tokens/max_output_tokens) are never advertised as the cap.
export function applyServingLimits(entry: any, attributes: any): any {
  const limits = resolveServingLimits(attributes);
  if (limits.contextWindow !== undefined) {
    entry.context_window = limits.contextWindow;
  }
  if (limits.maxCompletionTokens !== undefined) {
    entry.max_completion_tokens = limits.maxCompletionTokens;
  }
  return entry;
}

export async function getModelsHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    // 如果是浏览器直接访问 /models（Accept 包含 text/html 且没有认证头），
    // 返回前端应用的 index.html，让前端路由接管，而不是走虚拟密钥鉴权。
    const accept = String(request.headers.accept || '');
    if (!request.headers.authorization && accept.includes('text/html')) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.sendFile('index.html');
    }

    const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);
    const authResult = await authenticateVirtualKey(resolvedAuthHeader);
    if ('error' in authResult) {
      return reply.code(authResult.error.code).send(authResult.error.body);
    }

    const { virtualKey, virtualKeyValue } = authResult;
    const uniqueModelIds = getModelIdsFromVirtualKey(virtualKey);
    const modelPromises = uniqueModelIds.map(id => hotConfigCache.getModelById(id));
    const modelResults = await Promise.all(modelPromises);
    const models = modelResults.filter(model => model?.enabled);

    const modelList = models.map(model => {
      const baseInfo = buildModelBaseInfo(model!);
      const attributes = parseModelAttributes(model!.model_attributes);
      return applyServingLimits(mergeModelAttributes(baseInfo, attributes), attributes);
    });

    // §5.10: attach tier membership for tiered-routing (expert-routed) models.
    const tiersCache = new Map<string, Record<string, string[]> | null>();
    for (let i = 0; i < models.length; i++) {
      const routingId = models[i]?.expert_routing_id;
      if (!routingId) continue;
      if (!tiersCache.has(routingId)) {
        tiersCache.set(routingId, await buildRoutingTiers(routingId));
      }
      const tiers = tiersCache.get(routingId);
      if (tiers) modelList[i].routing_tiers = tiers;
    }

    memoryLogger.info(
      `Models list query: virtual key ${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)} | returned ${modelList.length} models`,
      'Proxy'
    );

    reply.header('Content-Type', 'application/json');
    return reply.send({
      object: 'list',
      data: modelList
    });
  } catch (error: any) {
    memoryLogger.error(
      `Models list query failed: ${error.message}`,
      'Proxy',
      { error: error.stack }
    );

    return reply.code(500).send({
      error: {
        message: error.message || 'Failed to query models list',
        type: 'internal_error',
        param: null,
        code: 'models_list_error'
      }
    });
  }
}

export async function getModelInfoHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const litellmCompatCfg = await systemConfigDb.get('litellm_compat_enabled');
    const litellmCompatEnabled = litellmCompatCfg ? litellmCompatCfg.value === 'true' : false;

    if (!litellmCompatEnabled) {
      return reply.code(404).send({
        error: {
          message: 'Protocol compatibility mode is not enabled',
          type: 'not_found_error',
          param: null,
          code: 'protocol_compat_disabled'
        }
      });
    }

    const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);
    const authResult = await authenticateVirtualKey(resolvedAuthHeader);
    if ('error' in authResult) {
      return reply.code(authResult.error.code).send(authResult.error.body);
    }

    const { virtualKey, virtualKeyValue } = authResult;
    const uniqueModelIds = getModelIdsFromVirtualKey(virtualKey);
    const modelPromises = uniqueModelIds.map(id => hotConfigCache.getModelById(id));
    const modelResults = await Promise.all(modelPromises);
    const models = modelResults.filter(model => model?.enabled);

    const modelList = models.map(model => {
      const modelName = model!.is_virtual ? model!.name : model!.model_identifier;
      const modelAttributes = parseModelAttributes(model!.model_attributes);

      const modelInfo: any = {
        max_tokens: modelAttributes.max_tokens || 8192,
        max_input_tokens: modelAttributes.max_input_tokens || 200000,
        max_output_tokens: modelAttributes.max_output_tokens || 8192,
        max_completion_tokens: modelAttributes.max_completion_tokens || 8192,
        context_window: modelAttributes.context_window || modelAttributes.context_length || modelAttributes.max_tokens || 200000,
        input_cost_per_token: modelAttributes.input_cost_per_token || 0.000003,
        output_cost_per_token: modelAttributes.output_cost_per_token || 0.000015,
        supports_vision: modelAttributes.supports_vision !== undefined ? modelAttributes.supports_vision : true,
        supports_prompt_caching: modelAttributes.supports_prompt_caching !== undefined ? modelAttributes.supports_prompt_caching : true,
        supports_function_calling: modelAttributes.supports_function_calling !== undefined ? modelAttributes.supports_function_calling : true,
      };

      if (modelAttributes.litellm_provider) {
        modelInfo.provider = modelAttributes.litellm_provider;
      }

      if (modelAttributes.mode) {
        modelInfo.mode = modelAttributes.mode;
      }

      return {
        model_name: modelName,
        litellm_params: {
          model: modelName,
        },
        model_info: modelInfo
      };
    });

    memoryLogger.info(
      `Model info query: virtual key ${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)} | returned ${modelList.length} models`,
      'Proxy'
    );

    reply.header('Content-Type', 'application/json');
    return reply.send({
      data: modelList
    });
  } catch (error: any) {
    memoryLogger.error(
      `Model info query failed: ${error.message}`,
      'Proxy',
      { error: error.stack }
    );

    return reply.code(500).send({
      error: {
        message: error.message || 'Failed to query model info',
        type: 'internal_error',
        param: null,
        code: 'model_info_error'
      }
    });
  }
}

