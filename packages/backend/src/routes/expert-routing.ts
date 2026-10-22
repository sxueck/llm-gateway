import { FastifyInstance } from "fastify";
import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  apiRequestDb,
  expertRoutingConfigDb,
  expertRoutingLogDb,
  expertRoutingSessionBindingDb,
  expertRoutingTrainingRecordDb,
  modelDb,
  virtualKeyDb,
  withTransaction,
} from "../db/index.js";
import { hotConfigCache } from "../services/hot-config-cache.js";
import { memoryLogger } from "../services/logger.js";
import { getJevBreakerState, getJevConfiguration } from "../services/expert-router/jev-client.js";
import { chooseDifficulty } from "../services/expert-router/jev-client.js";
import { SignalBuilder } from "../services/expert-router/preprocess/index.js";
import { groupByBand } from "../services/expert-router.js";
import { difficultyToBand, resolveBandCandidates } from "../services/expert-router/bands.js";
import {
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
} from "@llm-gateway/shared";
import {
  blendedPriceOf,
  buildBands,
} from "../services/expert-router/bands.js";
import { resolveExpertCost } from "../services/expert-router/cost.js";
import type {
  BandCandidate,
} from "../services/expert-router/bands.js";
import type {
  CostInput,
  RoutingBand,
} from "../types/expert-routing.js";

const expertTargetSchema = z.object({
  id: z.string(),
  type: z.enum(["virtual", "real"]),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
  // Optional here so the auto-banding preview can accept un-banded experts;
  // persisted configs must set it (validateExpertRoutingConfig).
  band: z.enum(["low", "medium", "high"]).optional(),
});

const sessionPolicySchema = z.object({
  mode: z.enum(["per_turn", "sticky", "escalate_only"]).default("escalate_only"),
  idle_ttl_seconds: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SESSION_IDLE_TTL_SECONDS),
  absolute_ttl_seconds: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS),
});

const classifierConfigSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    on_low_confidence: z.enum(["escalate", "keep"]).optional(),
    min_confidence: z.number().min(0).max(1).optional(),
  })
  .optional();

const exposureConfigSchema = z
  .object({
    headers: z.boolean().optional(),
    provider_header: z.boolean().optional(),
    model_field: z.enum(["upstream", "gateway_name"]).optional(),
    sse_comment: z.boolean().optional(),
  })
  .optional();

const fallbackConfigSchema = z
  .object({
    type: z.enum(["virtual", "real"]),
    model_id: z.string().optional(),
    provider_id: z.string().optional(),
    model: z.string().optional(),
  })
  .nullable()
  .optional();

const preprocessingSchema = z
  .object({
    strip_tools: z.boolean().optional(),
    strip_files: z.boolean().optional(),
    strip_code_blocks: z.boolean().optional(),
    strip_system_prompt: z.boolean().optional(),
  })
  .optional();

const createExpertRoutingSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  fail_open: z.enum(["fallback", "parent", "error"]).optional(),
  preprocessing: preprocessingSchema,
  experts: z.array(expertTargetSchema),
  fallback: fallbackConfigSchema,
  session_policy: sessionPolicySchema.optional(),
  classifier: classifierConfigSchema,
  exposure: exposureConfigSchema,
  createVirtualModel: z.boolean().optional(),
  virtualModelName: z.string().optional(),
  modelAttributes: z.any().optional(),
});

const updateExpertRoutingSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  fail_open: z.enum(["fallback", "parent", "error"]).optional(),
  preprocessing: preprocessingSchema,
  experts: z.array(expertTargetSchema).optional(),
  fallback: fallbackConfigSchema,
  session_policy: sessionPolicySchema.optional(),
  classifier: classifierConfigSchema,
  exposure: exposureConfigSchema,
  virtualModelName: z.string().optional(),
});

/**
 * v2 removed several v1 fields. Reject them with an explicit message instead
 * of silently stripping (zod default), so stale callers notice immediately.
 */
function httpError(statusCode: number, message: string): Error {
  const error: Error & { statusCode?: number } = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function errorResponse(statusCode: number, message: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: statusCode === 404 ? "not_found" : "validation_error",
    },
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw httpError(
        400,
        `请求参数验证失败: ${error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    throw error;
  }
}

function rejectDeprecatedFields(body: any): void {
  const removed: string[] = [];
  if (body && typeof body === "object") {
    if ("choice_threshold" in body) removed.push("choice_threshold");
    if ("classification_mode" in body) removed.push("classification_mode");
    if ("session_binding_policy" in body) removed.push("session_binding_policy");
    if (Array.isArray(body.experts)) {
      for (const expert of body.experts) {
        if (expert && typeof expert === "object") {
          for (const field of ["category", "description", "color"] as const) {
            if (field in expert) removed.push(`experts[].${field}`);
          }
        }
      }
    }
  }
  if (removed.length > 0) {
    throw httpError(
      400,
      `字段已废弃 (v2 已移除按类别路由): ${[...new Set(removed)].join(", ")}`,
    );
  }
}

async function validateModelConfig(
  config: any,
  configType: string,
): Promise<void> {
  if (config.type === "virtual") {
    if (!config.model_id) {
      throw httpError(400, `${configType}虚拟模型未指定 model_id`);
    }

    const virtualModel = await modelDb.getById(config.model_id);
    if (!virtualModel) {
      throw httpError(400, `${configType}虚拟模型不存在: ${config.model_id}`);
    }

    if (!virtualModel.enabled) {
      throw httpError(400, `${configType}虚拟模型 "${virtualModel.name}" 已被禁用`);
    }
  } else {
    if (!config.provider_id) {
      throw httpError(400, `${configType}真实模型未指定 provider_id`);
    }
    if (!config.model) {
      throw httpError(400, `${configType}真实模型未指定 model`);
    }
  }
}

function validateSessionPolicy(policy: any): void {
  const idle = Number(policy?.idle_ttl_seconds);
  const absolute = Number(policy?.absolute_ttl_seconds);
  if (!Number.isFinite(idle) || idle <= 0) {
    throw httpError(400, "session_policy.idle_ttl_seconds 必须为正整数");
  }
  if (!Number.isFinite(absolute) || absolute <= 0) {
    throw httpError(400, "session_policy.absolute_ttl_seconds 必须为正整数");
  }
  if (idle > absolute) {
    throw httpError(
      400,
      "session_policy.idle_ttl_seconds 不能大于 absolute_ttl_seconds",
    );
  }
}

async function validateExpertConfig(
  expert: any,
  currentExpertRoutingId?: string,
): Promise<void> {
  await validateModelConfig(expert, `候选模型 "${expert.id}"`);

  if (expert.type === "virtual") {
    const virtualModel = await modelDb.getById(expert.model_id);

    if (virtualModel!.expert_routing_id) {
      if (
        currentExpertRoutingId &&
        virtualModel!.expert_routing_id === currentExpertRoutingId
      ) {
        throw httpError(
          400,
          `候选模型 "${expert.id}" 的虚拟模型 "${virtualModel!.name}" 引用了当前分级路由配置,会导致循环依赖。` +
            `请选择其他模型。`,
        );
      }
    }
  }
}

async function validateFallbackConfig(
  fallback: any,
  currentExpertRoutingId?: string,
): Promise<void> {
  await validateModelConfig(fallback, "降级");

  if (fallback.type === "virtual") {
    const virtualModel = await modelDb.getById(fallback.model_id);

    if (virtualModel!.expert_routing_id) {
      if (
        currentExpertRoutingId &&
        virtualModel!.expert_routing_id === currentExpertRoutingId
      ) {
        throw httpError(
          400,
          `降级虚拟模型 "${virtualModel!.name}" 引用了当前专家路由配置,会导致循环依赖。` +
            `请选择其他模型。`,
        );
      }
    }
  }
}

// 空草稿契约：experts 可为空（草稿态，必须保持禁用）；非空时逐项校验。
// 启用门搶（非空才能 enable）由 create/update 处理器执行。
async function validateExpertRoutingConfig(
  config: any,
  currentExpertRoutingId?: string,
): Promise<void> {
  const experts: any[] = Array.isArray(config.experts) ? config.experts : [];
  const ids = new Set<string>();
  for (const expert of experts) {
    if (ids.has(expert.id)) throw httpError(400, `重复的候选模型 ID: ${expert.id}`);
    ids.add(expert.id);
    if (
      expert.band !== "low" &&
      expert.band !== "medium" &&
      expert.band !== "high"
    ) {
      throw httpError(400, `候选模型 ${expert.id} 缺少 band (low/medium/high)`);
    }
    await validateExpertConfig(expert, currentExpertRoutingId);
  }

  if (config.fallback) {
    await validateFallbackConfig(config.fallback, currentExpertRoutingId);
  }

  validateSessionPolicy(config.session_policy);
}

/**
 * Map a stored route_source value to the canonical 4-value vocabulary. Legacy
 * layer sources (llm, l1_/l2_/l3_*) roll up to llm_second_pass.
 */
function normalizeRouteSource(raw: string | null): string | null {
  if (!raw) return null;
  if (
    raw === "session" ||
    raw === "jev" ||
    raw === "fail_open" ||
    raw === "manual" ||
    raw === "intent_api" ||
    raw === "llm_second_pass" ||
    raw === "fallback"
  ) {
    return raw;
  }
  return "llm_second_pass";
}

/**
 * Assemble the persisted config object, applying a session-binding default when
 * omitted. When `current` is provided (update),
 * unspecified fields fall back to the existing stored values.
 */
function buildConfigData(body: any, current?: any): any {
  const sessionPolicy = body.session_policy ||
    current?.session_policy || current?.session_binding_policy || {
      mode: "escalate_only",
      idle_ttl_seconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
      absolute_ttl_seconds: DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
    };
  return {
    version: 2 as const,
    fail_open: body.fail_open ?? current?.fail_open,
    preprocessing:
      body.preprocessing !== undefined
        ? body.preprocessing
        : current?.preprocessing,
    experts: body.experts || current?.experts || [],
    fallback: body.fallback !== undefined ? body.fallback : current?.fallback,
    session_policy: sessionPolicy,
    classifier: body.classifier !== undefined ? body.classifier : current?.classifier,
    exposure: body.exposure !== undefined ? body.exposure : current?.exposure,
  };
}

/**
 * AC-6: when an expert mapping is removed or its target changes, invalidate any
 * durable session bindings pointing at it so a stale route cannot be used.
 */
async function invalidateBindingsForExpertChanges(
  expertRoutingId: string,
  prevExperts: any[],
  nextExperts: any[],
  connection?: PoolConnection,
): Promise<string[]> {
  const prevById = new Map(prevExperts.map((e) => [e.id, e]));
  const nextById = new Map(nextExperts.map((e) => [e.id, e]));
  const changedOrRemoved: string[] = [];
  for (const [id, prev] of prevById) {
    const next = nextById.get(id);
    if (!next) {
      changedOrRemoved.push(id);
    } else if (
      prev.band !== next.band ||
      prev.type !== next.type ||
      prev.model_id !== next.model_id ||
      prev.provider_id !== next.provider_id ||
      prev.model !== next.model
    ) {
      changedOrRemoved.push(id);
    }
  }
  const messages: string[] = [];
  for (const expertId of changedOrRemoved) {
    const n = await expertRoutingSessionBindingDb.deleteByExpert(
      expertRoutingId,
      expertId,
      connection,
    );
    if (n > 0) {
      messages.push(`专家映射变更失效会话绑定 | expert=${expertId} | 清除=${n}`);
    }
  }
  return messages;
}

async function computeBandPreview(experts: BandCandidate[]) {
  const costOf = new Map<string, CostInput | undefined>();
  for (const expert of experts) {
    costOf.set(expert.id, await resolveExpertCost(expert));
  }
  const bands = buildBands(experts, (expert) => costOf.get(expert.id));
  const assignment: Record<string, RoutingBand> = {};
  const describe = (expert: BandCandidate) => {
    assignment[expert.id] = expert.band!;
    return {
      id: expert.id,
      type: expert.type,
      explicitBand: expert.band ?? null,
      blendedPrice: blendedPriceOf(costOf.get(expert.id)),
      inputCostPerToken: costOf.get(expert.id)?.input_cost_per_token ?? null,
      outputCostPerToken: costOf.get(expert.id)?.output_cost_per_token ?? null,
    };
  };
  return {
    bands: {
      low: bands.low.map(describe),
      medium: bands.medium.map(describe),
      high: bands.high.map(describe),
    },
    assignment: assignment as Record<string, RoutingBand>,
  };
}

/** Nearest-rank percentile over a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return Math.round(sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]);
}

export async function expertRoutingRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // §5.5: classifier runtime status for the read-only classifier panel.
  fastify.get("/jev/status", async () => {
    let configured = true;
    let model: string | null = null;
    try {
      model = getJevConfiguration().model;
    } catch {
      configured = false;
    }
    return { configured, model, breaker: getJevBreakerState() };
  });

  /** The exposed (对外) model row for a config: virtual + created by this config. */
  async function findExposedModel(configId: string, connection?: PoolConnection) {
    const models = (await modelDb.getByExpertRoutingId(configId, connection)) as any[];
    return (
      models.find(
        (m) => m.is_virtual === 1 && m.model_identifier === `expert-${configId}`,
      ) ?? null
    );
  }

  function serializeVirtualModel(model: any) {
    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      modelIdentifier: model.model_identifier,
      isVirtual: true,
      expertRoutingId: model.expert_routing_id,
    };
  }

  function safeJsonParse(value?: string | null): any {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      // Some fields are stored as plain strings (e.g. fallback markers, non-L3 sources).
      return value;
    }
  }

  function inferRouteSource(log: any): string | null {
    if (log?.route_source) return String(log.route_source);

    // Some deployments might not have v22 columns; fall back to existing fields.
    const req = log?.classifier_request;
    if (typeof req === "string") {
      if (req === "llm") return "llm";
      if (
        req === "l1_semantic" ||
        req === "l2_llm" ||
        req === "l3_llm" ||
        req === "fallback"
      )
        return req;
      if (
        req.startsWith("l1_") ||
        req.startsWith("l2_") ||
        req.startsWith("l3_")
      )
        return req;
    }

    const model = String(log?.classifier_model || "");
    if (model === "fallback") return "fallback";
    if (model === "heuristic") return "l2_heuristic";
    if (model.startsWith("semantic/")) return "l1_semantic";
    return "llm";
  }

  function inferSemanticScore(log: any): number | undefined {
    if (log?.semantic_score !== undefined && log?.semantic_score !== null) {
      const n = Number(log.semantic_score);
      return Number.isFinite(n) ? n : undefined;
    }
    const source = inferRouteSource(log);
    if (source !== "l1_semantic") return undefined;
    try {
      const parsed = safeJsonParse(log?.classifier_response);
      const score = parsed?.top1?.score;
      const n = Number(score);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }

  fastify.get("/", async () => {
    try {
      const configs = await expertRoutingConfigDb.getAll();
      return {
        configs: await Promise.all(
          (configs as any[]).map(async (c) => {
            const exposedModel = await findExposedModel(c.id);
            return {
              id: c.id,
              name: c.name,
              description: c.description,
              enabled: c.enabled === 1,
              config: JSON.parse(c.config),
              createdAt: c.created_at,
              updatedAt: c.updated_at,
              virtualModel: exposedModel
                ? serializeVirtualModel(exposedModel)
                : null,
            };
          }),
        ),
      };
    } catch (error: any) {
      memoryLogger.error(
        `获取专家路由配置失败: ${error.message}`,
        "ExpertRouting",
      );
      throw error;
    }
  });

  fastify.get("/:id", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const config = await expertRoutingConfigDb.getById(id);

      if (!config) {
        throw new Error("专家路由配置不存在");
      }

      const exposedModel = await findExposedModel(id);

      return {
        id: config.id,
        name: config.name,
        description: config.description,
        enabled: config.enabled === 1,
        config: JSON.parse(config.config),
        createdAt: config.created_at,
        updatedAt: config.updated_at,
        virtualModel: exposedModel ? serializeVirtualModel(exposedModel) : null,
      };
    } catch (error: any) {
      memoryLogger.error(
        `获取专家路由配置失败: ${error.message}`,
        "ExpertRouting",
      );
      throw error;
    }
  });

  fastify.post("/", async (request, reply) => {
    try {
      rejectDeprecatedFields(request.body);
      const body = parseBody(createExpertRoutingSchema, request.body);

      const configData = buildConfigData(body, undefined);

      await validateExpertRoutingConfig(configData);

      // 空草稿强制以禁用状态创建：无候选模型的启用配置在代理时会直接报错。
      const expertsEmpty = !Array.isArray(configData.experts) || configData.experts.length === 0;
      const enabled = !expertsEmpty && body.enabled !== false ? 1 : 0;

      const configId = nanoid();
      const config = await expertRoutingConfigDb.create({
        id: configId,
        name: body.name,
        description: body.description,
        enabled,
        config: JSON.stringify(configData),
      });

      memoryLogger.info(`创建专家路由配置: ${config!.name}`, "ExpertRouting");

      let virtualModel = null;
      if (body.createVirtualModel !== false) {
        const virtualModelName = body.virtualModelName || body.name;

        virtualModel = await modelDb.create({
          id: nanoid(),
          name: virtualModelName,
          provider_id: null,
          model_identifier: `expert-${configId}`,
          is_virtual: 1,
          routing_config_id: null,
          expert_routing_id: configId,
          enabled: 1,
          model_attributes: body.modelAttributes
            ? JSON.stringify(body.modelAttributes)
            : null,
          prompt_config: null,
          compression_config: null,
        });
        memoryLogger.info(`创建专家模型: ${virtualModelName}`, "ExpertRouting");
      }

      return {
        id: config!.id,
        name: config!.name,
        description: config!.description,
        enabled: config!.enabled === 1,
        config: JSON.parse(config!.config),
        createdAt: config!.created_at,
        updatedAt: config!.updated_at,
        virtualModel: virtualModel ? serializeVirtualModel(virtualModel) : null,
      };
    } catch (error: any) {
      memoryLogger.error(
        `创建专家路由配置失败: ${error.message}`,
        "ExpertRouting",
      );
      if (error.statusCode && error.statusCode !== 500) {
        return reply
          .code(error.statusCode)
          .send(errorResponse(error.statusCode, error.message));
      }
      throw error;
    }
  });

  fastify.put("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      rejectDeprecatedFields(request.body);
      const body = parseBody(updateExpertRoutingSchema, request.body);

      const existingConfig = await expertRoutingConfigDb.getById(id);
      if (!existingConfig) {
        throw httpError(404, "专家路由配置不存在");
      }

      let configData: ReturnType<typeof buildConfigData>;
      const currentConfig = JSON.parse(existingConfig.config);
      if (
        body.fail_open !== undefined ||
        body.experts ||
        body.fallback !== undefined ||
        body.preprocessing !== undefined ||
        body.session_policy !== undefined ||
        body.classifier !== undefined ||
        body.exposure !== undefined
      ) {
        configData = buildConfigData(body, currentConfig);

        await validateExpertRoutingConfig(configData, id);

      }

      // 启用门搶：空草稿（无候选模型）不允许启用。
      const nextExperts = configData?.experts ?? currentConfig.experts ?? [];
      const willEnable =
        body.enabled !== undefined ? body.enabled : existingConfig.enabled === 1;
      if (willEnable && nextExperts.length === 0) {
        throw httpError(400, "启用前至少需要配置一个候选模型");
      }

      // 对外模型名：显式提供时优先于配置名同步；空串视为不变更。
      const customExposedName = body.virtualModelName?.trim();
      const changedModelIds: string[] = [];
      const changeMessages: string[] = [];
      const { updatedConfig, updatedExposedModel } = await withTransaction(async (connection) => {
        // Lock even model-only saves so concurrent creates cannot expose two models for one config.
        const lockedConfig = await expertRoutingConfigDb.getById(id, connection);
        if (!lockedConfig) throw httpError(404, "专家路由配置不存在");

        await expertRoutingConfigDb.update(id, {
          name: body.name,
          description: body.description ?? undefined,
          enabled:
            body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
          config: configData ? JSON.stringify(configData) : undefined,
        }, connection);

        if (body.experts) {
          changeMessages.push(...await invalidateBindingsForExpertChanges(
            id, currentConfig.experts || [], configData.experts, connection,
          ));
        }

        if (body.name && body.name !== lockedConfig.name && !customExposedName) {
          const associatedModels = await modelDb.getByExpertRoutingId(id, connection);
          for (const model of associatedModels) {
            await modelDb.update(model.id, { name: body.name }, connection);
            changedModelIds.push(model.id);
          }
          changeMessages.push(`同步更新专家路由关联模型名称: ${associatedModels.length} 个`);
        }

        if (customExposedName) {
          const exposedModel = await findExposedModel(id, connection);
          if (exposedModel && exposedModel.name !== customExposedName) {
            await modelDb.update(exposedModel.id, { name: customExposedName }, connection);
            changedModelIds.push(exposedModel.id);
            changeMessages.push(`重命名专家模型: "${exposedModel.name}" -> "${customExposedName}"`);
          }
          if (!exposedModel) {
            const createdModel = await modelDb.create({
              id: nanoid(),
              name: customExposedName,
              provider_id: null,
              model_identifier: `expert-${id}`,
              is_virtual: 1,
              routing_config_id: null,
              expert_routing_id: id,
              enabled: 1,
              model_attributes: null,
              prompt_config: null,
              compression_config: null,
            }, connection);
            changedModelIds.push(createdModel.id);
            changeMessages.push(`创建专家模型: ${customExposedName}`);
          }
        }

        return {
          updatedConfig: await expertRoutingConfigDb.getById(id, connection),
          updatedExposedModel: await findExposedModel(id, connection),
        };
      });

      for (const modelId of changedModelIds) hotConfigCache.invalidateModel(modelId);
      for (const message of changeMessages) memoryLogger.info(message, "ExpertRouting");
      memoryLogger.info(`更新专家路由配置: ${id}`, "ExpertRouting");
      return {
        id: updatedConfig!.id,
        name: updatedConfig!.name,
        description: updatedConfig!.description,
        enabled: updatedConfig!.enabled === 1,
        config: JSON.parse(updatedConfig!.config),
        createdAt: updatedConfig!.created_at,
        updatedAt: updatedConfig!.updated_at,
        virtualModel: updatedExposedModel
          ? serializeVirtualModel(updatedExposedModel)
          : null,
      };
    } catch (error: any) {
      memoryLogger.error(
        `更新专家路由配置失败: ${error.message}`,
        "ExpertRouting",
      );
      if (error.statusCode && error.statusCode !== 500) {
        return reply
          .code(error.statusCode)
          .send(errorResponse(error.statusCode, error.message));
      }
      throw error;
    }
  });

  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const existingConfig = await expertRoutingConfigDb.getById(id);
      if (!existingConfig) {
        throw httpError(404, "专家路由配置不存在");
      }

      const associatedModels = await modelDb.getByExpertRoutingId(id);

      // 引用完整性：待删除的专家模型仍被虚拟密钥引用时拒绝删除，避免悬空引用
      const modelsToDelete = associatedModels.filter(
        (model) =>
          model.is_virtual === 1 && model.model_identifier === `expert-${id}`,
      );
      if (modelsToDelete.length > 0) {
        const virtualKeyCounts = await virtualKeyDb.countByModels(
          modelsToDelete.map((m) => ({
            id: m.id,
            provider_id: m.provider_id,
            model_identifier: m.model_identifier,
            name: m.name,
          })),
        );
        const referencedModels = modelsToDelete.filter(
          (m) => (virtualKeyCounts.get(m.id) || 0) > 0,
        );
        if (referencedModels.length > 0) {
          const names = referencedModels.map((m) => m.name).join("、");
          return reply
            .code(400)
            .send(
              errorResponse(
                400,
                `无法删除专家路由配置，${referencedModels.length} 个专家模型仍被虚拟密钥引用（${names}），请先解除引用后重试`,
              ),
            );
        }
      }

      let deletedModels = 0;
      let detachedModels = 0;

      for (const model of associatedModels) {
        const shouldDelete =
          model.is_virtual === 1 && model.model_identifier === `expert-${id}`;
        if (shouldDelete) {
          await modelDb.delete(model.id);
          hotConfigCache.invalidateModel(model.id);
          deletedModels++;
        } else {
          await modelDb.update(model.id, { expert_routing_id: null });
          hotConfigCache.invalidateModel(model.id);
          detachedModels++;
        }
      }

      await expertRoutingConfigDb.delete(id);
      const clearedBindings =
        await expertRoutingSessionBindingDb.deleteByConfig(id);
      memoryLogger.info(
        `删除专家路由配置: ${id} | 删除专家模型: ${deletedModels} 个 | 解绑模型: ${detachedModels} 个 | 清除会话绑定: ${clearedBindings} 个`,
        "ExpertRouting",
      );
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(
        `删除专家路由配置失败: ${error.message}`,
        "ExpertRouting",
      );
      if (error.statusCode && error.statusCode !== 500) {
        return reply
          .code(error.statusCode)
          .send(errorResponse(error.statusCode, error.message));
      }
      throw error;
    }
  });

  fastify.post("/bands/preview", async (request) => {
    const body = z.object({ experts: z.array(expertTargetSchema).min(1) }).parse(request.body);
    return computeBandPreview(body.experts);
  });

  /**
   * §3.3 RoutingSimulator: classify a prompt against a config WITHOUT calling
   * any upstream and WITHOUT writing session bindings or routing logs. Shared
   * by the unsaved-config endpoint (/simulate) and the saved-config one.
   */
  async function simulateRouting(
    config: { experts: any[]; preprocessing?: any },
    requestBody: any,
  ) {
    const request = {
      body: requestBody?.messages ? { messages: requestBody.messages } : { messages: [{ role: "user", content: requestBody?.prompt ?? "" }] },
      headers: {},
    };
    const signal = await SignalBuilder.buildRoutingSignal(request as any, config.preprocessing);
    const start = performance.now();
    let decision;
    try {
      decision = await chooseDifficulty(signal.intentText || "");
    } catch (error: any) {
      const err: any = new Error(
        `Jev 分类器不可用: ${error?.message || error}`,
      );
      err.statusCode = 503;
      throw err;
    }
    const classifierTimeMs = Math.round(performance.now() - start);
    const experts = config.experts as any[];
    const bands = groupByBand(experts);
    const band = difficultyToBand(decision.verdict);
    const ordered = resolveBandCandidates(bands, band);
    return {
      intentText: signal.intentText,
      stats: signal.stats,
      difficulty: decision.verdict,
      confidence: decision.confidence,
      ranked: decision.ranked,
      classifierModel: decision.model,
      classifierTimeMs,
      band,
      candidates: ordered.map((expert) => ({
        id: expert.id,
        band: expert.band,
        type: expert.type,
      })),
      // Without touching upstream we cannot know health/circuit state; the
      // would-be hit is simply the first candidate in v2 order.
      wouldHit: ordered[0]?.id ?? null,
    };
  }

  const simulateBodySchema = z.object({
    prompt: z.string().optional(),
    messages: z.array(z.any()).optional(),
    config: z
      .object({
        experts: z.array(expertTargetSchema).min(1),
        preprocessing: preprocessingSchema,
      })
      .optional(),
  });

  fastify.post("/simulate", async (request) => {
    const body = simulateBodySchema.parse(request.body ?? {});
    if (!body.prompt && !body.messages) {
      const err: any = new Error("prompt 或 messages 至少提供一个");
      err.statusCode = 400;
      throw err;
    }
    return simulateRouting(body.config!, body);
  });

  fastify.post("/:id/simulate", async (request) => {
    const { id } = request.params as { id: string };
    const body = simulateBodySchema.parse(request.body ?? {});
    if (!body.prompt && !body.messages) {
      const err: any = new Error("prompt 或 messages 至少提供一个");
      err.statusCode = 400;
      throw err;
    }
    const row = await expertRoutingConfigDb.getById(id);
    if (!row) {
      throw new Error("专家路由配置不存在");
    }
    let config: any;
    try {
      config = JSON.parse(row.config);
    } catch {
      throw new Error("专家路由配置是非法 JSON");
    }
    return simulateRouting(config, body);
  });

  fastify.get("/:id/bands/preview", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error("专家路由配置不存在");
      }
      const parsed = JSON.parse(config.config);
      return computeBandPreview((parsed.experts || []) as BandCandidate[]);
    } catch (error: any) {
      memoryLogger.error(`获取带宽预览失败: ${error.message}`, "ExpertRouting");
      throw error;
    }
  });

  fastify.post("/:id/bands/preview", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = z
        .object({ experts: z.array(expertTargetSchema).optional() })
        .parse(request.body ?? {});
      let experts = body.experts;
      if (!experts) {
        const config = await expertRoutingConfigDb.getById(id);
        if (!config) {
          throw new Error("专家路由配置不存在");
        }
        experts = (JSON.parse(config.config).experts || []) as BandCandidate[];
      }
      return computeBandPreview(experts);
    } catch (error: any) {
      memoryLogger.error(`获取带宽预览失败: ${error.message}`, "ExpertRouting");
      throw error;
    }
  });

  fastify.get("/:id/statistics", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { timeRange } = request.query as { timeRange?: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error("专家路由配置不存在");
      }

      const timeRangeMs = timeRange ? Number.parseInt(timeRange) : undefined;
      const stats = await expertRoutingLogDb.getStatistics(id, timeRangeMs);
      const routeStats = await expertRoutingLogDb.getRouteStats(
        id,
        timeRangeMs,
      );
      const difficultyStats = await expertRoutingLogDb.getDifficultyStats(
        id,
        timeRangeMs,
      );
      const latencies = await expertRoutingLogDb.getClassifierLatencies(
        id,
        timeRangeMs,
      );
      const classifierLatency = {
        count: latencies.length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        avg:
          latencies.length > 0
            ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
            : null,
      };

      let totalRequests = 0;
      let totalClassificationTime = 0;

      for (const row of stats as any[]) {
        totalRequests += Number(row.count);
        totalClassificationTime += Number(row.avg_time) * Number(row.count);
      }

      const routeSourceDistribution: Record<string, number> = {};
      let totalCleanedLength = 0;
      let totalPromptTokens = 0;
      let cleaningCount = 0;

      if ((routeStats as any[]).length > 0) {
        for (const row of routeStats as any[]) {
          const raw = row.route_source ? String(row.route_source) : null;
          // Keep historical route sources distinct from Jev decisions.
          const normalized = normalizeRouteSource(raw);
          if (normalized) {
            routeSourceDistribution[normalized] =
              (routeSourceDistribution[normalized] || 0) + Number(row.count);
          }
          const count = Number(row.count);
          totalCleanedLength += Number(row.avg_cleaned_length || 0) * count;
          totalPromptTokens += Number(row.avg_prompt_tokens || 0) * count;
          cleaningCount += count;
        }
      } else {
        // Fallback when stats columns (route_source/prompt_tokens/cleaned_content_length) are missing.
        const modelStats = await expertRoutingLogDb.getClassifierModelStats(
          id,
          timeRangeMs,
        );
        for (const row of modelStats as any[]) {
          const model = String(row.classifier_model || "");
          const count = Number(row.count);
          let source = "llm_second_pass";
          if (model === "fallback") source = "fallback";
          else if (model.includes("jev")) source = "jev";
          routeSourceDistribution[source] =
            (routeSourceDistribution[source] || 0) + count;
        }
      }

      const cleaningStats = {
        avgPromptTokens:
          cleaningCount > 0 ? Math.round(totalPromptTokens / cleaningCount) : 0,
        avgCleanedLength:
          cleaningCount > 0
            ? Math.round(totalCleanedLength / cleaningCount)
            : 0,
        totalRequests: cleaningCount,
      };

      const avgClassificationTime =
        totalRequests > 0
          ? Math.round(totalClassificationTime / totalRequests)
          : 0;

      const difficultyDistribution: Record<string, number> = {};
      const bandDistribution: Record<string, number> = {};
      let difficultyRows = 0;
      for (const row of difficultyStats as any[]) {
        const count = Number(row.count) || 0;
        difficultyRows += count;
        const difficultyKey = row.difficulty ? String(row.difficulty) : "unclassified";
        difficultyDistribution[difficultyKey] =
          (difficultyDistribution[difficultyKey] || 0) + count;
        const bandKey = row.band ? String(row.band) : "unknown";
        bandDistribution[bandKey] = (bandDistribution[bandKey] || 0) + count;
      }

      // Parent-routing requests are not persisted here, so this is a lower bound.
      let failOpenRate: number | null = null;
      if ((routeStats as any[]).length > 0 && totalRequests > 0) {
        const failOpenCount = (routeSourceDistribution["fail_open"] || 0) +
          (routeSourceDistribution["fallback"] || 0);
        failOpenRate = Math.round((failOpenCount / totalRequests) * 10000) / 10000;
      }

      // §5.8: saving vs all-high computed from actual api_requests tokens
      // linked via route_log_id. Cache-hit tokens price at the selected
      // model's cached input rate (fallback: full input price — never an
      // imaginary discount); the baseline prices every token at the CHEAPEST
      // high-tier expert (conservative: understates the saving).
      const decisions = await expertRoutingLogDb.getRecentRoutingDecisions(id, timeRangeMs);
      const configExperts = (() => {
        try {
          return (JSON.parse(config.config).experts || []) as any[];
        } catch {
          return [];
        }
      })();
      const priceOf = new Map<string, CostInput | undefined>();
      for (const expert of configExperts) {
        priceOf.set(expert.id, await resolveExpertCost(expert));
      }
      const priced = (p: CostInput | undefined): p is CostInput =>
        Number.isFinite(Number(p?.input_cost_per_token)) &&
        Number(p?.input_cost_per_token) >= 0 &&
        Number.isFinite(Number(p?.output_cost_per_token)) &&
        Number(p?.output_cost_per_token) >= 0;
      const highPrices = configExperts
        .filter((expert) => expert.band === "high")
        .map((expert) => priceOf.get(expert.id))
        .filter(priced);
      const usageRows =
        decisions.length > 0 && highPrices.length > 0
          ? await apiRequestDb.getUsageByRouteLogIds(
              decisions.map((row: any) => String(row.id)),
            )
          : [];
      const decisionById = new Map(
        decisions.map((row: any) => [String(row.id), row]),
      );
      const roundCost = (value: number) => Math.round(value * 1e6) / 1e6;
      let actualCost = 0;
      let baselineCost = 0;
      let linkedRequests = 0;
      let cacheHitTokens = 0;
      if (highPrices.length > 0) {
        const baseline = highPrices.reduce((a, b) =>
          blendedPriceOf(a) <= blendedPriceOf(b) ? a : b,
        );
        for (const usage of usageRows as any[]) {
          const decision = decisionById.get(String(usage.route_log_id));
          if (!decision) continue;
          const price = priceOf.get(decision.selected_expert_id);
          if (!price || !priced(price)) continue;
          const prompt = Number(usage.prompt_tokens) || 0;
          const completion = Number(usage.completion_tokens) || 0;
          const cached = Math.min(Number(usage.cached_tokens) || 0, prompt);
          const cachePrice =
            Number.isFinite(Number(price.input_cost_per_token_cache_hit)) &&
            Number(price.input_cost_per_token_cache_hit) >= 0
              ? Number(price.input_cost_per_token_cache_hit)
              : Number(price.input_cost_per_token);
          actualCost +=
            (prompt - cached) * Number(price.input_cost_per_token) +
            cached * cachePrice +
            completion * Number(price.output_cost_per_token);
          baselineCost +=
            prompt * Number(baseline.input_cost_per_token) +
            completion * Number(baseline.output_cost_per_token);
          cacheHitTokens += cached;
          linkedRequests += 1;
        }
      }
      const estimatedSavingVsHighBand =
        highPrices.length > 0
          ? {
              actualCost: roundCost(actualCost),
              baselineCost: roundCost(baselineCost),
              saving: roundCost(baselineCost - actualCost),
              savingPct:
                baselineCost > 0
                  ? Math.round(((baselineCost - actualCost) / baselineCost) * 10000) / 100
                  : null,
              linkedRequests,
              cacheHitTokens,
            }
          : null;

      const limitations: string[] = [
        "failOpenRate excludes parent-routed requests without expert routing logs",
      ];
      if (difficultyRows === 0) {
        limitations.push(
          "difficulty/band distributions unavailable: no persisted v47 rows",
        );
      }
      if (!estimatedSavingVsHighBand) {
        limitations.push(
          "estimatedSavingVsHighBand unavailable: no priced high-tier expert to baseline against",
        );
      }

      return {
        totalRequests,
        avgClassificationTime,
        classifierLatency,
        routeSourceDistribution,
        cleaningStats,
        difficultyDistribution,
        bandDistribution,
        failOpenRate,
        estimatedSavingVsHighBand,
        limitations,
      };
    } catch (error: any) {
      memoryLogger.error(
        `获取专家路由统计失败: ${error.message}`,
        "ExpertRouting",
      );
      throw error;
    }
  });

  fastify.get("/:id/logs", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error("专家路由配置不存在");
      }

      const limitNum = limit ? Number.parseInt(limit) : 100;
      const logs = (
        (await expertRoutingLogDb.getByConfigId(id, limitNum)) as any[]
      ).map((log) => ({
        ...log,
        route_source: inferRouteSource(log),
        semantic_score: inferSemanticScore(log),
      }));

      return { logs };
    } catch (error: any) {
      memoryLogger.error(
        `获取专家路由日志失败: ${error.message}`,
        "ExpertRouting",
      );
      throw error;
    }
  });

  fastify.get("/:id/logs/:logId/details", async (request) => {
    try {
      const { id, logId } = request.params as { id: string; logId: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error("专家路由配置不存在");
      }

      const log = await expertRoutingLogDb.getById(logId);
      if (!log) {
        throw new Error("日志不存在");
      }

      if (log.expert_routing_id !== id) {
        throw new Error("日志不属于该专家路由配置");
      }

      const inferredSource = inferRouteSource(log);

      return {
        id: log.id,
        virtual_key_id: log.virtual_key_id,
        expert_routing_id: log.expert_routing_id,
        request_hash: log.request_hash,
        classifier_model: log.classifier_model,
        classification_result: log.classification_result,
        selected_expert_id: log.selected_expert_id,
        selected_expert_type: log.selected_expert_type,
        selected_expert_name: log.selected_expert_name,
        classification_time: log.classification_time,
        created_at: log.created_at,
        original_request: safeJsonParse(log.original_request),
        classifier_request: safeJsonParse(log.classifier_request),
        classifier_response: safeJsonParse(log.classifier_response),
        route_source: inferredSource,
        difficulty: log.difficulty ?? null,
        band: log.band ?? null,
        verdict_reused: log.verdict_reused ? 1 : 0,
        classifier_time_ms: log.classifier_time_ms ?? null,
        prompt_tokens: log.prompt_tokens ?? undefined,
        cleaned_content_length: log.cleaned_content_length ?? undefined,
        semantic_score: inferSemanticScore(log),
      };
    } catch (error: any) {
      memoryLogger.error(`获取日志详情失败: ${error.message}`, "ExpertRouting");
      throw error;
    }
  });

  /**
   * §5.9 misclassification feedback: mark a routing log as judged too low or
   * too high; the corrected tier is persisted as a replay-set training record
   * (reusing expert_routing_training_records, upserted by request hash).
   */
  fastify.post("/:id/logs/:logId/feedback", async (request) => {
    const { id, logId } = request.params as { id: string; logId: string };
    const body = z
      .object({ rating: z.enum(["too_low", "too_high"]) })
      .parse(request.body ?? {});
    const config = await expertRoutingConfigDb.getById(id);
    if (!config) {
      throw new Error("专家路由配置不存在");
    }
    const log = await expertRoutingLogDb.getById(logId);
    if (!log || log.expert_routing_id !== id) {
      throw new Error("日志不存在");
    }
    const order: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];
    const judged = order.indexOf(
      (String(log.difficulty || log.band || "low") as "low" | "medium" | "high"),
    );
    const corrected =
      body.rating === "too_low"
        ? order[Math.min(order.length - 1, judged + 1)]
        : order[Math.max(0, judged - 1)];
    let judgedConfidence = 0;
    try {
      const parsed = JSON.parse(String(log.classifier_response || "{}"));
      judgedConfidence = Number(parsed?.verdictConfidence ?? parsed?.probability ?? 0) || 0;
    } catch {
      judgedConfidence = 0;
    }
    await expertRoutingTrainingRecordDb.upsertFeedback({
      id: nanoid(),
      expert_routing_id: id,
      input_hash: log.request_hash,
      input_text:
        (log as any).intent_text ||
        `request_hash=${log.request_hash} (intent_text 未持久化，早于 v54)`,
      judge_intent_label: String(log.difficulty || log.band || "unknown"),
      judge_confidence: judgedConfidence,
      final_intent_label: corrected,
      final_expert_id: log.selected_expert_id || null,
    });
    memoryLogger.info(
      `误判反馈: ${logId} rating=${body.rating} corrected=${corrected}`,
      "ExpertRouting",
    );
    return { success: true, corrected };
  });

  /** §5.9 replay-set export for classifier tuning. */
  fastify.get("/:id/training/records", async (request) => {
    const { id } = request.params as { id: string };
    const { status, limit } = request.query as { status?: string; limit?: string };
    const config = await expertRoutingConfigDb.getById(id);
    if (!config) {
      throw new Error("专家路由配置不存在");
    }
    const allowedStatus =
      status === "pending_review" || status === "accepted" || status === "rejected"
        ? (status as "pending_review" | "accepted" | "rejected")
        : undefined;
    const records = await expertRoutingTrainingRecordDb.listByConfig(id, {
      status: allowedStatus,
      limit: limit ? Number.parseInt(limit) : undefined,
    });
    return { records };
  });

  fastify.post("/:id/models", async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { modelIds } = request.body as { modelIds: string[] };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error("专家路由配置不存在");
      }

      for (const modelId of modelIds) {
        const model = await modelDb.getById(modelId);
        if (model) {
          await modelDb.update(modelId, {
            expert_routing_id: id,
          });
          hotConfigCache.invalidateModel(modelId);
        }
      }

      memoryLogger.info(
        `关联模型到专家路由: ${id} | 模型数量: ${modelIds.length}`,
        "ExpertRouting",
      );

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`关联模型失败: ${error.message}`, "ExpertRouting");
      throw error;
    }
  });

  fastify.delete("/:id/models/:modelId", async (request) => {
    try {
      const { id, modelId } = request.params as { id: string; modelId: string };

      const model = await modelDb.getById(modelId);
      if (!model) {
        throw new Error("模型不存在");
      }

      if (model.expert_routing_id !== id) {
        throw new Error("模型未关联到此专家路由");
      }

      await modelDb.update(modelId, {
        expert_routing_id: null,
      });
      hotConfigCache.invalidateModel(modelId);

      memoryLogger.info(
        `取消模型关联: ${modelId} | 专家路由: ${id}`,
        "ExpertRouting",
      );

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`取消模型关联失败: ${error.message}`, "ExpertRouting");
      throw error;
    }
  });
}
