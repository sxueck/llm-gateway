import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { appConfig } from "../config/index.js";
import { listExecutableNodeIds, nodeOwnerError } from "../config/node.js";
import { modelDb, providerDb, virtualKeyDb } from "../db/index.js";
import { hotConfigCache } from "../services/hot-config-cache.js";
import { isRemoteProvider, nodeError, providerOwner } from "../services/node-dispatch.js";
import {
  executeProviderTestLocally,
  fetchUpstreamModelsLocally,
  forwardNodeOperationReply,
  isPrivateNodeTransport,
} from "../services/node-operations.js";
import { encryptApiKey, decryptApiKey } from "../utils/crypto.js";

export { mapUpstreamModelList } from "../services/node-operations.js";

function safeParseJson(value: string | null | undefined): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// 转发上限略高于 owner 侧执行超时（TCP 5s / 模型列表 10s），留出通道开销。
const PROVIDER_TEST_FORWARD_TIMEOUT_MS = 20000;
const FETCH_MODELS_FORWARD_TIMEOUT_MS = 30000;

const protocolMappingSchema = z
  .object({
    openai: z.string().url().optional(),
    anthropic: z.string().url().optional(),
    google: z.string().url().optional(),
  })
  .nullable()
  .optional();

const ownerNodeSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    "ownerNode 必须以小写字母开头，仅含小写字母、数字、连字符，长度 1-32",
  )
  .nullable()
  .optional();

const createProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  baseUrl: z.string().url(),
  protocolMappings: protocolMappingSchema,
  apiKey: z.string(),
  modelMapping: z.record(z.string()).optional(),
  ownerNode: ownerNodeSchema,
  enabled: z.boolean().optional(),
});

const updateProviderSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  baseUrl: z.string().url().optional(),
  protocolMappings: protocolMappingSchema,
  apiKey: z.string().optional(),
  modelMapping: z.record(z.string()).optional(),
  ownerNode: ownerNodeSchema,
  enabled: z.boolean().optional(),
});

const fetchModelsSchema = z
  .object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    ownerNode: ownerNodeSchema,
  })
  .strict();

const batchImportSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      baseUrl: z.string().url(),
      apiKey: z.string(),
      ownerNode: ownerNodeSchema,
      enabled: z.boolean().optional(),
    }),
  ),
  skipExisting: z.boolean().optional(),
});

// 校验失败统一回 400（含 ownerNode 格式错误），避免落入全局 500 处理器。
function parseRequestBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  reply: FastifyReply,
): T | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.code(400).send({
      error: {
        message: result.error.issues.map((issue) => issue.message).join("; "),
        type: "invalid_request_error",
        param: null,
        code: "validation_error",
      },
    });
    return null;
  }
  return result.data;
}

// 格式合法但指向未配置/已下线节点的归属会让该供应商流量永久 503
//（故障不接管是设计行为），所以写入时就必须确认 owner 可执行。
function rejectUnknownOwnerNode(
  ownerNode: string | null | undefined,
  reply: FastifyReply,
): boolean {
  if (!ownerNode) return false;
  const message = nodeOwnerError(ownerNode, appConfig.node);
  if (!message) return false;
  reply.code(400).send({
    error: { message, type: "invalid_request_error", param: "ownerNode", code: "unknown_owner_node" },
  });
  return true;
}

export async function providerRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/node-options", async () => ({
    enabled: appConfig.node.enabled,
    nodeId: appConfig.node.id,
    controlId: appConfig.node.controlId,
    nodeIds: listExecutableNodeIds(appConfig.node),
  }));

  fastify.get("/", async () => {
    const providers = await providerDb.getAll();
    return {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        baseUrl: p.base_url,
        protocolMappings: safeParseJson(p.protocol_mappings),
        apiKey: "***",
        modelMapping: safeParseJson(p.model_mapping),
        ownerNode: p.owner_node ?? null,
        enabled: p.enabled === 1,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    };
  });

  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { includeApiKey } = request.query as { includeApiKey?: string };
    const provider = await providerDb.getById(id);

    if (!provider) {
      return reply.code(404).send({ error: "提供商不存在" });
    }

    const result = {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      baseUrl: provider.base_url,
      protocolMappings: safeParseJson(provider.protocol_mappings),
      apiKey:
        includeApiKey === "true" ? decryptApiKey(provider.api_key) : "***",
      modelMapping: safeParseJson(provider.model_mapping),
      ownerNode: provider.owner_node ?? null,
      enabled: provider.enabled === 1,
      createdAt: provider.created_at,
      updatedAt: provider.updated_at,
    };

    fastify.log.info(
      {
        providerId: id,
        protocolMappingsRaw: provider.protocol_mappings,
        protocolMappingsParsed: result.protocolMappings,
      },
      "[Providers] Getting provider by id",
    );

    return result;
  });

  fastify.post("/", async (request, reply) => {
    const body = parseRequestBody(createProviderSchema, request.body, reply);
    if (!body) return reply;
    if (rejectUnknownOwnerNode(body.ownerNode, reply)) return reply;

    const existing = await providerDb.getById(body.id);
    if (existing) {
      return reply.code(400).send({ error: "提供商 ID 已存在" });
    }

    const provider = await providerDb.create({
      id: body.id,
      name: body.name,
      description: body.description,
      base_url: body.baseUrl,
      protocol_mappings: body.protocolMappings
        ? JSON.stringify(body.protocolMappings)
        : null,
      api_key: encryptApiKey(body.apiKey),
      model_mapping: body.modelMapping
        ? JSON.stringify(body.modelMapping)
        : null,
      owner_node: body.ownerNode ?? null,
      enabled: body.enabled === false ? 0 : 1,
    });

    return {
      id: provider.id,
      name: provider.name,
      description: provider.description,
      baseUrl: provider.base_url,
      protocolMappings: safeParseJson(provider.protocol_mappings),
      modelMapping: safeParseJson(provider.model_mapping),
      ownerNode: provider.owner_node ?? null,
      enabled: provider.enabled === 1,
      createdAt: provider.created_at,
      updatedAt: provider.updated_at,
    };
  });

  fastify.put("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseRequestBody(updateProviderSchema, request.body, reply);
    if (!body) return reply;
    if (rejectUnknownOwnerNode(body.ownerNode, reply)) return reply;

    fastify.log.info({ providerId: id, body }, "[Providers] Updating provider");

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: "提供商不存在" });
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.baseUrl !== undefined) updates.base_url = body.baseUrl;
    if (body.protocolMappings !== undefined) {
      updates.protocol_mappings = body.protocolMappings
        ? JSON.stringify(body.protocolMappings)
        : null;
      fastify.log.info(
        {
          protocolMappings: body.protocolMappings,
          stringified: updates.protocol_mappings,
        },
        "[Providers] Protocol mappings update",
      );
    }
    if (body.apiKey !== undefined) updates.api_key = encryptApiKey(body.apiKey);
    if (body.modelMapping !== undefined) {
      updates.model_mapping = body.modelMapping
        ? JSON.stringify(body.modelMapping)
        : null;
    }
    // 显式 null 会清除归属（回归默认控制节点），不会静默丢弃
    if (body.ownerNode !== undefined) updates.owner_node = body.ownerNode;
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;

    fastify.log.info({ updates }, "[Providers] Final updates to apply");

    await providerDb.update(id, updates);
    hotConfigCache.invalidateProvider(id);

    const updated = await providerDb.getById(id);
    if (!updated) {
      throw new Error("提供商不存在");
    }

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      baseUrl: updated.base_url,
      protocolMappings: safeParseJson(updated.protocol_mappings),
      modelMapping: safeParseJson(updated.model_mapping),
      ownerNode: updated.owner_node ?? null,
      enabled: updated.enabled === 1,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: "提供商不存在" });
    }

    // 引用完整性：提供商下的模型仍被虚拟密钥引用时拒绝删除，避免悬空引用
    const providerModels = await modelDb.getByProviderId(id);
    if (providerModels.length > 0) {
      const virtualKeyCounts = await virtualKeyDb.countByModels(
        providerModels.map((m) => ({
          id: m.id,
          provider_id: m.provider_id,
          model_identifier: m.model_identifier,
          name: m.name,
        })),
      );
      const referencedModels = providerModels.filter(
        (m) => (virtualKeyCounts.get(m.id) || 0) > 0,
      );
      if (referencedModels.length > 0) {
        const names = referencedModels.map((m) => m.name).join("、");
        return reply.code(400).send({
          error: `无法删除提供商，其下 ${referencedModels.length} 个模型仍被虚拟密钥引用（${names}），请先解除引用后重试`,
        });
      }
    }

    await providerDb.delete(id);
    hotConfigCache.invalidateProvider(id);
    hotConfigCache.invalidateModelsByProviderId(id);

    return { success: true };
  });

  fastify.post("/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: "提供商不存在" });
    }

    // 远端归属的提供商只能在 owner 节点上测试（就近探测出口网络）；
    // 操作仅携带 providerId，密钥不出库，转发失败也不回退本地执行。
    if (isRemoteProvider(provider)) {
      return forwardNodeOperationReply(
        reply,
        providerOwner(provider),
        { op: "provider-test", providerId: id },
        PROVIDER_TEST_FORWARD_TIMEOUT_MS,
      );
    }

    return executeProviderTestLocally(id, provider.base_url);
  });

  fastify.post("/fetch-models", async (request, reply) => {
    const body = parseRequestBody(fetchModelsSchema, request.body, reply);
    if (!body) return reply;
    if (rejectUnknownOwnerNode(body.ownerNode, reply)) return reply;

    // ownerNode 缺省表示默认控制节点；非本节点归属时必须转发给对应 owner 节点。
    // 未落盘的 apiKey 只经签名节点通道传输，且仅限加密/内网链路，不记录载荷。
    const ownerNode = body.ownerNode ?? appConfig.node.controlId;
    if (ownerNode !== appConfig.node.id) {
      if (!isPrivateNodeTransport(ownerNode)) {
        return reply.code(503).send(
          nodeError(
            "node_transport_insecure",
            `Owner node '${ownerNode}' is not reachable over an encrypted or private transport; refusing to transmit provider credentials`,
          ),
        );
      }
      return forwardNodeOperationReply(
        reply,
        ownerNode,
        {
          op: "fetch-models",
          ownerNode,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
        },
        FETCH_MODELS_FORWARD_TIMEOUT_MS,
      );
    }

    return fetchUpstreamModelsLocally(body.baseUrl, body.apiKey);
  });

  fastify.post("/batch-import", async (request, reply) => {
    const body = parseRequestBody(batchImportSchema, request.body, reply);
    if (!body) return reply;
    for (const provider of body.providers) {
      if (rejectUnknownOwnerNode(provider.ownerNode, reply)) return reply;
    }
    const { providers, skipExisting = true } = body;

    const results = {
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [] as Array<{ id: string; error: string }>,
    };

    for (const providerData of providers) {
      try {
        const existing = await providerDb.getById(providerData.id);

        if (existing) {
          if (skipExisting) {
            results.skipped++;
            continue;
          } else {
            results.errors.push({
              id: providerData.id,
              error: "提供商 ID 已存在",
            });
            results.failed++;
            continue;
          }
        }

        await providerDb.create({
          id: providerData.id,
          name: providerData.name,
          description: providerData.description,
          base_url: providerData.baseUrl,
          protocol_mappings: null,
          api_key: encryptApiKey(providerData.apiKey),
          model_mapping: null,
          owner_node: providerData.ownerNode ?? null,
          enabled: providerData.enabled === false ? 0 : 1,
        });

        results.success++;
      } catch (error: any) {
        results.errors.push({
          id: providerData.id,
          error: error.message || "创建失败",
        });
        results.failed++;
      }
    }

    return {
      success: results.failed === 0,
      message: `导入完成: 成功 ${results.success} 个，跳过 ${results.skipped} 个，失败 ${results.failed} 个`,
      results,
    };
  });
}
