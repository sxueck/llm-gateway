import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { apiRequestDb, modelDb, providerDb, routingConfigDb, virtualKeyDb } from "../db/index.js";
import { hotConfigCache } from "../services/hot-config-cache.js";
import { decryptApiKey } from "../utils/crypto.js";
import { probeService } from "../services/probe-service.js";
import {
  getProviderSupportedProtocols,
} from "../utils/protocol-utils.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}

const baseModelAttributesSchema = z.object({
  input_cost_per_token: z.number().optional(),
  output_cost_per_token: z.number().optional(),
  input_cost_per_token_cache_hit: z.number().optional(),

  // capability metadata surfaced in GET /v1/models and /v1/model/info;
  // sourced from upstream /v1/models entries (max_completion_tokens, context_length, ...)
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  max_input_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  context_length: z.number().optional(),
  context_window: z.number().optional(),
  limit: z.number().optional(),
  supports_vision: z.boolean().optional(),
  supports_prompt_caching: z.boolean().optional(),
  supports_function_calling: z.boolean().optional(),
  disable_thinking: z.boolean().optional(),

  litellm_provider: z.string().optional(),
  provider: z.string().optional(),
  mode: z.string().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().optional(),
  maxRetries: z.number().optional(),
  requestTimeout: z.number().optional(),
  upstream_websocket_enabled: z.boolean().optional(),
});

export const modelAttributesSchema = baseModelAttributesSchema
  .transform((val) => {
    if (!val) return val;
    const { provider, ...rest } = val as any;
    if (provider && !rest.litellm_provider) {
      (rest as any).litellm_provider = provider;
    }
    return rest as any;
  })
  .optional();

function parseModelAttributesSafe(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 手动测试的探测协议：未指定时取供应商提供的首个协议；显式指定时必须是供应商能力成员，非法返回 null。
 */
export function resolveTestProbeProtocol(
  provider: { base_url?: string | null; protocol_mappings?: string | null } | null,
  requested?: string,
): string | null {
  const supported = getProviderSupportedProtocols(provider);
  if (requested === undefined) {
    return supported[0] ?? null;
  }
  return supported.includes(requested) ? requested : null;
}

const createModelSchema = z.object({
  name: z.string(),
  providerId: z.string().optional(),
  modelIdentifier: z.string(),
  isVirtual: z.boolean().optional(),
  routingConfigId: z.string().optional(),
  enabled: z.boolean().optional(),
  modelAttributes: modelAttributesSchema,
});

const updateModelSchema = z.object({
  name: z.string().optional(),
  modelIdentifier: z.string().optional(),
  enabled: z.boolean().optional(),
  modelAttributes: modelAttributesSchema,
});

export async function modelRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async () => {
    const models = await modelDb.getAll();
    const providers = await providerDb.getAll();
    const providerMap = new Map(providers.map((p) => [p.id, p]));

    const modelRefInfos = models.map((m) => ({
      id: m.id,
      provider_id: m.provider_id,
      model_identifier: m.model_identifier,
      name: m.name,
    }));
    const virtualKeyCounts = await virtualKeyDb.countByModels(modelRefInfos);

    // 被动可用性：近 24h api_requests 聚合，无流量则不出现在 map 中（前端显示"暂无调用"）
    const availabilityData = await apiRequestDb.getModelAvailability();
    const availabilityBuckets = new Map<
      string,
      { start: number; total: number; success: number }[]
    >();
    for (const row of availabilityData.buckets) {
      const key = `${row.provider_id}|${row.model}`;
      const list = availabilityBuckets.get(key) ?? [];
      list.push({
        start: Number(row.bucket_start),
        total: Number(row.total),
        success: Number(row.success),
      });
      availabilityBuckets.set(key, list);
    }
    const availabilityByKey = new Map<
      string,
      {
        windowHours: number;
        total: number;
        success: number;
        lastUsedAt: number;
        buckets: { start: number; total: number; success: number }[];
      }
    >();
    for (const row of availabilityData.totals) {
      const key = `${row.provider_id}|${row.model}`;
      availabilityByKey.set(key, {
        windowHours: 24,
        total: Number(row.total),
        success: Number(row.success),
        lastUsedAt: Number(row.last_used_at),
        buckets: availabilityBuckets.get(key) ?? [],
      });
    }

    const modelPromises = models.map(async (m) => {
      const provider = m.provider_id ? providerMap.get(m.provider_id) : null;
      const virtualKeyCount = virtualKeyCounts.get(m.id) || 0;

      const modelAttributes = parseModelAttributesSafe(m.model_attributes);

      // 协议能力由供应商派生；虚拟模型不直接对外提供协议
      const supportedProtocols =
        m.is_virtual === 1 ? [] : getProviderSupportedProtocols(provider);

      const availability =
        m.is_virtual === 1
          ? null
          : (availabilityByKey.get(`${m.provider_id}|${m.model_identifier}`) ??
            null);

      return {
        id: m.id,
        name: m.name,
        providerId: m.provider_id,
        providerName:
          m.is_virtual === 1 ? "虚拟模型" : provider?.name || "未知提供商",
        modelIdentifier: m.model_identifier,
        supportedProtocols,
        isVirtual: m.is_virtual === 1,
        routingConfigId: m.routing_config_id,
        expertRoutingId: m.expert_routing_id,
        enabled: m.enabled === 1,
        modelAttributes,
        virtualKeyCount,
        availability,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      };
    });

    return {
      models: await Promise.all(modelPromises),
    };
  });

  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = await modelDb.getById(id);

    if (!model) {
      return reply.code(404).send({ error: "模型不存在" });
    }

    const provider = model.provider_id
      ? await providerDb.getById(model.provider_id)
      : null;
    const virtualKeyCount = await virtualKeyDb
      .countByModels([
        {
          id: model.id,
          provider_id: model.provider_id,
          model_identifier: model.model_identifier,
          name: model.name,
        },
      ])
      .then((map) => map.get(model.id) || 0);

    const modelAttributes = parseModelAttributesSafe(model.model_attributes);

    const supportedProtocols =
      model.is_virtual === 1 ? [] : getProviderSupportedProtocols(provider);

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      providerName:
        model.is_virtual === 1 ? "虚拟模型" : provider?.name || "未知提供商",
      modelIdentifier: model.model_identifier,
      supportedProtocols,
      enabled: model.enabled === 1,
      modelAttributes,
      virtualKeyCount,
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
  });

  fastify.post("/", async (request, reply) => {
    const body = createModelSchema.parse(request.body);

    let provider: Awaited<ReturnType<typeof providerDb.getById>> | null =
      null;
    if (body.providerId) {
      provider = await providerDb.getById(body.providerId);
      if (!provider) {
        return reply.code(400).send({ error: "提供商不存在" });
      }
    } else if (!body.isVirtual) {
      return reply.code(400).send({ error: "非虚拟模型必须关联提供商" });
    }

    if (body.routingConfigId) {
      const routingConfig = await routingConfigDb.getById(body.routingConfigId);
      if (!routingConfig) {
        return reply.code(400).send({ error: "路由配置不存在" });
      }
    }

    const model = await modelDb.create({
      id: nanoid(),
      name: body.name,
      provider_id: body.providerId || null,
      model_identifier: body.modelIdentifier,
      is_virtual: body.isVirtual ? 1 : 0,
      routing_config_id: body.routingConfigId || null,
      enabled: body.enabled === false ? 0 : 1,
      model_attributes: body.modelAttributes
        ? JSON.stringify(body.modelAttributes)
        : null,
      prompt_config: null,
      compression_config: null,
    });

    const modelAttributes = parseModelAttributesSafe(model.model_attributes);

    const supportedProtocols =
      model.is_virtual === 1 ? [] : getProviderSupportedProtocols(provider);

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      modelIdentifier: model.model_identifier,
      supportedProtocols,
      isVirtual: model.is_virtual === 1,
      routingConfigId: model.routing_config_id,
      enabled: model.enabled === 1,
      modelAttributes,
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
  });

  fastify.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateModelSchema.parse(request.body);

    const model = await modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: "模型不存在" });
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.modelIdentifier !== undefined)
      updates.model_identifier = body.modelIdentifier;
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
    if (body.modelAttributes !== undefined) {
      updates.model_attributes =
        body.modelAttributes && Object.keys(body.modelAttributes).length > 0
          ? JSON.stringify(body.modelAttributes)
          : null;
    }

    await modelDb.update(id, updates);
    hotConfigCache.invalidateModel(id);

    const updated = await modelDb.getById(id);
    if (!updated) {
      throw new Error("模型不存在");
    }

    const modelAttributes = parseModelAttributesSafe(updated.model_attributes);

    const updatedProvider = updated.provider_id
      ? await providerDb.getById(updated.provider_id)
      : null;
    const supportedProtocols =
      updated.is_virtual === 1
        ? []
        : getProviderSupportedProtocols(updatedProvider);

    return {
      id: updated.id,
      name: updated.name,
      providerId: updated.provider_id,
      modelIdentifier: updated.model_identifier,
      supportedProtocols,
      enabled: updated.enabled === 1,
      modelAttributes,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const model = await modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: "模型不存在" });
    }

    const virtualKeyCount = await virtualKeyDb
      .countByModels([
        {
          id: model.id,
          provider_id: model.provider_id,
          model_identifier: model.model_identifier,
          name: model.name,
        },
      ])
      .then((map) => map.get(model.id) || 0);

    if (virtualKeyCount > 0) {
      return reply.code(400).send({
        error: `无法删除模型，有 ${virtualKeyCount} 个虚拟密钥正在引用此模型`,
      });
    }

    await modelDb.delete(id);
    hotConfigCache.invalidateModel(id);
    return { success: true };
  });

  fastify.get("/by-provider/:providerId", async (request) => {
    const { providerId } = request.params as { providerId: string };
    const models = await modelDb.getByProviderId(providerId);

    return {
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        providerId: m.provider_id,
        modelIdentifier: m.model_identifier,
        isVirtual: m.is_virtual === 1,
        enabled: m.enabled === 1,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      })),
    };
  });

  fastify.post("/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { protocol: requestedProtocol } = (request.body ?? {}) as {
      protocol?: string;
    };
    const model = await modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: "模型不存在" });
    }

    if (model.is_virtual === 1) {
      return reply.code(400).send({ error: "虚拟模型无法直接测试" });
    }

    const provider = await providerDb.getById(model.provider_id!);
    if (!provider) {
      return reply.code(400).send({ error: "关联的提供商不存在" });
    }

    const probeProtocol = resolveTestProbeProtocol(provider, requestedProtocol);
    if (probeProtocol === null) {
      return reply
        .code(400)
        .send({ error: "探测协议必须是供应商提供协议的成员" });
    }

    const apiKey = decryptApiKey(provider.api_key);
    const result = await probeService.probeModelViaProvider({
      modelIdentifier: model.model_identifier,
      protocol: probeProtocol as any,
      provider,
      apiKey,
      prompt: "测试",
      timeoutMs: 30000,
    });

    return result;
  });
}
