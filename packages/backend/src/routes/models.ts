import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { modelDb, providerDb, virtualKeyDb } from "../db/index.js";
import { hotConfigCache } from "../services/hot-config-cache.js";
import { decryptApiKey } from "../utils/crypto.js";
import { probeService } from "../services/probe-service.js";
import {
  parseSupportedProtocols,
  resolveProbeProtocol,
} from "../utils/protocol-utils.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}

const protocolEnum = z.enum(["openai", "anthropic", "google"]);

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

function validateHealthCheckMembership(
  supported: string[] | undefined,
  healthCheck: string | undefined,
) {
  if (
    healthCheck !== undefined &&
    supported !== undefined &&
    !supported.includes(healthCheck)
  ) {
    throw new Error("healthCheckProtocol 必须是 supportedProtocols 的成员");
  }
}

function parseModelAttributesSafe(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const createModelSchema = z
  .object({
    name: z.string(),
    providerId: z.string().optional(),
    modelIdentifier: z.string(),
    supportedProtocols: z.array(protocolEnum).min(1).optional(),
    healthCheckProtocol: protocolEnum.optional(),
    isVirtual: z.boolean().optional(),
    routingConfigId: z.string().optional(),
    enabled: z.boolean().optional(),
    modelAttributes: modelAttributesSchema,
  })
  .transform((data) => {
    const supported = data.supportedProtocols ?? ["openai"];
    const healthCheck = data.healthCheckProtocol ?? supported[0];
    validateHealthCheckMembership(supported, healthCheck);
    return {
      ...data,
      supportedProtocols: supported,
      healthCheckProtocol: healthCheck,
    };
  });

const updateModelSchema = z.object({
  name: z.string().optional(),
  modelIdentifier: z.string().optional(),
  supportedProtocols: z.array(protocolEnum).min(1).optional(),
  healthCheckProtocol: protocolEnum.optional(),
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

    const modelPromises = models.map(async (m) => {
      const provider = m.provider_id ? providerMap.get(m.provider_id) : null;
      const virtualKeyCount = virtualKeyCounts.get(m.id) || 0;

      const modelAttributes = parseModelAttributesSafe(m.model_attributes);

      const supportedProtocols = parseSupportedProtocols(m.supported_protocols);

      return {
        id: m.id,
        name: m.name,
        providerId: m.provider_id,
        providerName:
          m.is_virtual === 1 ? "虚拟模型" : provider?.name || "未知提供商",
        modelIdentifier: m.model_identifier,
        supportedProtocols,
        healthCheckProtocol: m.health_check_protocol,
        isVirtual: m.is_virtual === 1,
        routingConfigId: m.routing_config_id,
        expertRoutingId: m.expert_routing_id,
        enabled: m.enabled === 1,
        modelAttributes,
        virtualKeyCount,
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

    const supportedProtocols = parseSupportedProtocols(
      model.supported_protocols,
    );

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      providerName:
        model.is_virtual === 1 ? "虚拟模型" : provider?.name || "未知提供商",
      modelIdentifier: model.model_identifier,
      supportedProtocols,
      healthCheckProtocol: model.health_check_protocol,
      enabled: model.enabled === 1,
      modelAttributes,
      virtualKeyCount,
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
  });

  fastify.post("/", async (request, reply) => {
    const body = createModelSchema.parse(request.body);

    if (body.providerId) {
      const provider = await providerDb.getById(body.providerId);
      if (!provider) {
        return reply.code(400).send({ error: "提供商不存在" });
      }
    } else if (!body.isVirtual) {
      return reply.code(400).send({ error: "非虚拟模型必须关联提供商" });
    }

    const model = await modelDb.create({
      id: nanoid(),
      name: body.name,
      provider_id: body.providerId || null,
      model_identifier: body.modelIdentifier,
      supported_protocols: JSON.stringify(body.supportedProtocols),
      health_check_protocol: body.healthCheckProtocol ?? null,
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

    const supportedProtocols = parseSupportedProtocols(
      model.supported_protocols,
    );

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      modelIdentifier: model.model_identifier,
      supportedProtocols,
      healthCheckProtocol: model.health_check_protocol,
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

    const resolvedSupported =
      body.supportedProtocols ??
      parseSupportedProtocols(model.supported_protocols);
    if (body.healthCheckProtocol !== undefined) {
      validateHealthCheckMembership(
        resolvedSupported,
        body.healthCheckProtocol,
      );
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.modelIdentifier !== undefined)
      updates.model_identifier = body.modelIdentifier;
    if (body.supportedProtocols !== undefined) {
      updates.supported_protocols = JSON.stringify(body.supportedProtocols);
      // 如果 health_check_protocol 不再属于新的 supportedProtocols，重置为第一个
      const currentHealthCheck =
        body.healthCheckProtocol === undefined
          ? model.health_check_protocol
          : body.healthCheckProtocol;
      if (
        currentHealthCheck &&
        !(body.supportedProtocols as string[]).includes(currentHealthCheck)
      ) {
        updates.health_check_protocol = body.supportedProtocols[0];
      }
    }
    if (body.healthCheckProtocol !== undefined) {
      updates.health_check_protocol = body.healthCheckProtocol ?? null;
    }
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

    const supportedProtocols = parseSupportedProtocols(
      updated.supported_protocols,
    );

    return {
      id: updated.id,
      name: updated.name,
      providerId: updated.provider_id,
      modelIdentifier: updated.model_identifier,
      supportedProtocols,
      healthCheckProtocol: updated.health_check_protocol,
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

    const probeProtocol = resolveProbeProtocol(model);

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
