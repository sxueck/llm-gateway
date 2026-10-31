import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { virtualKeyDb, providerDb, modelDb, contextNormalizationDb, withTransaction } from '../db/index.js';
import { hotConfigCache } from '../services/hot-config-cache.js';
import { memoryLogger } from '../services/logger.js';
import { virtualKeyQuota } from '../services/virtual-key-quota.js';
import { hashKey, maskKey } from '../utils/crypto.js';
import { validateCustomKey } from '../utils/validation.js';
import { contextBudgetTokensSchema, virtualKeyRoutingStrategySchema } from '@llm-gateway/shared';

// `null` means "clear this setting" and is distinct from an omitted field, which
// means "leave it alone". NInputNumber emits null when its box is emptied, so the
// clearable fields must accept it or the admin form cannot unset anything.
const nullablePositiveNumberSchema = z.number().nullable();
const nullableTemperatureSchema = z.number().min(0).max(2).nullable();
// A key with zero bindings resolves to neither model_id nor model_ids and every
// proxied request then fails with invalid_model_config, so an empty list is refused.
const modelIdsSchema = z.array(z.string()).min(1).optional();

const createVirtualKeySchema = z.object({
  name: z.string(),
  providerId: z.string().optional(),
  modelId: z.string().nullable().optional(),
  routingStrategy: virtualKeyRoutingStrategySchema.optional(),
  modelIds: modelIdsSchema,
  routingConfig: z.record(z.any()).optional(),
  keyType: z.enum(['auto', 'custom']),
  customKey: z.string().optional(),
  rateLimit: nullablePositiveNumberSchema.optional(),
  enabled: z.boolean().optional(),
  cacheEnabled: z.boolean().optional(),
  disableLogging: z.boolean().optional(),
  contextBudgetTokens: contextBudgetTokensSchema.optional(),
  imageCompressionEnabled: z.boolean().optional(),
  interceptZeroTemperature: z.boolean().optional(),
  zeroTemperatureReplacement: nullableTemperatureSchema.optional(),
  piiProtectionEnabled: z.boolean().optional(),
  contextNormalizationEnabled: z.boolean().optional(),
});

const updateVirtualKeySchema = z.object({
  name: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().nullable().optional(),
  routingStrategy: virtualKeyRoutingStrategySchema.optional(),
  modelIds: modelIdsSchema,
  routingConfig: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
  rateLimit: nullablePositiveNumberSchema.optional(),
  cacheEnabled: z.boolean().optional(),
  disableLogging: z.boolean().optional(),
  contextBudgetTokens: contextBudgetTokensSchema.optional(),
  imageCompressionEnabled: z.boolean().optional(),
  interceptZeroTemperature: z.boolean().optional(),
  zeroTemperatureReplacement: nullableTemperatureSchema.optional(),
  piiProtectionEnabled: z.boolean().optional(),
  contextNormalizationEnabled: z.boolean().optional(),
});

const rotateVirtualKeySchema = z.object({
  keyType: z.enum(['auto', 'custom']),
  customKey: z.string().optional(),
});

// 每日 token 软配额（issue 39）：单位 M（百万 tokens），按网关时区自然日计量；
// null 是显式删除信号，未列出的模型不受影响。
const quotaEntrySchema = z.object({
  model: z.string().trim().min(1, '额度配置缺少模型名'),
  limitMillions: z
    .number({ invalid_type_error: '额度必须是数字（单位 M）或 null' })
    .finite()
    .min(0.001, '额度必须是不小于 0.001 的数字（单位 M）')
    .nullable(),
});

const quotaBulkSchema = z.object({
  virtualKeyIds: z.array(z.string().min(1)).min(1, 'virtualKeyIds 不能为空'),
  quotas: z.array(quotaEntrySchema),
});

// The getByKeyValue pre-check only covers the common case; UNIQUE(key_value) is the
// real guard, and a concurrent writer surfaces here as ER_DUP_ENTRY.
function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY';
}

export async function virtualKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Zod .parse throws inside the handlers and the global error handler has no
  // validation branch, so an invalid admin payload would otherwise reach the client
  // as 500 internal_error — indistinguishable from a real server fault.
  fastify.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof z.ZodError) {
      const [issue] = error.issues;
      return reply.code(400).send({
        error: {
          message: issue?.message ?? '请求参数验证失败',
          type: 'invalid_request_error',
          param: issue?.path.length ? issue.path.join('.') : null,
          code: 'validation_error',
        },
      });
    }

    return reply.code(error.statusCode || 500).send({
      error: {
        message: error.message || '服务器内部错误',
        type: 'internal_error',
        param: null,
        code: 'internal_server_error',
      },
    });
  });

  fastify.get('/', async () => {
    const virtualKeys = await virtualKeyDb.getAll();
    return {
      virtualKeys: virtualKeys.map(vk => ({
        id: vk.id,
        // 明文只允许在 create/rotate 的响应里出现一次；列表/详情一律掩码。
        keyValue: maskKey(vk.key_value),
        name: vk.name,
        providerId: vk.provider_id,
        modelId: vk.model_id,
        routingStrategy: vk.routing_strategy,
        modelIds: vk.model_ids ? JSON.parse(vk.model_ids) : null,
        routingConfig: vk.routing_config ? JSON.parse(vk.routing_config) : null,
        enabled: vk.enabled === 1,
        rateLimit: vk.rate_limit,
        cacheEnabled: vk.cache_enabled === 1,
        disableLogging: vk.disable_logging === 1,
        contextBudgetTokens: vk.context_budget_tokens ?? null,
        imageCompressionEnabled: vk.image_compression_enabled === 1,
        interceptZeroTemperature: vk.intercept_zero_temperature === 1,
        zeroTemperatureReplacement: vk.zero_temperature_replacement != null ? Number(vk.zero_temperature_replacement) : null,
        piiProtectionEnabled: vk.pii_protection_enabled === 1,
        contextNormalizationEnabled: vk.context_normalization_enabled === 1,
        createdAt: vk.created_at,
        updatedAt: vk.updated_at,
      })),
    };
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const vk = await virtualKeyDb.getById(id);

    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    return {
      id: vk.id,
      keyValue: maskKey(vk.key_value),
      name: vk.name,
      providerId: vk.provider_id,
      modelId: vk.model_id,
      routingStrategy: vk.routing_strategy,
      modelIds: vk.model_ids ? JSON.parse(vk.model_ids) : null,
      routingConfig: vk.routing_config ? JSON.parse(vk.routing_config) : null,
      enabled: vk.enabled === 1,
      rateLimit: vk.rate_limit,
      cacheEnabled: vk.cache_enabled === 1,
      disableLogging: vk.disable_logging === 1,
      contextBudgetTokens: vk.context_budget_tokens ?? null,
      imageCompressionEnabled: vk.image_compression_enabled === 1,
      interceptZeroTemperature: vk.intercept_zero_temperature === 1,
      zeroTemperatureReplacement: vk.zero_temperature_replacement != null ? Number(vk.zero_temperature_replacement) : null,
      piiProtectionEnabled: vk.pii_protection_enabled === 1,
      contextNormalizationEnabled: vk.context_normalization_enabled === 1,
      createdAt: vk.created_at,
      updatedAt: vk.updated_at,
    };
  });

  fastify.post('/', async (request, reply) => {
    const body = createVirtualKeySchema.parse(request.body);

    if (body.modelId) {
      const model = await modelDb.getById(body.modelId);
      if (!model) {
        return reply.code(400).send({ error: '模型不存在' });
      }
    }

    if (body.modelIds && body.modelIds.length > 0) {
      const modelIdentifiers = new Set<string>();
      const modelNames = new Set<string>();

      for (const modelId of body.modelIds) {
        const model = await modelDb.getById(modelId);
        if (!model) {
          return reply.code(400).send({ error: `模型 ${modelId} 不存在` });
        }

        // 检查是否有同名模型（基于 model_identifier）
        if (modelIdentifiers.has(model.model_identifier)) {
          return reply.code(400).send({
            error: `不允许绑定同名模型: 模型标识 "${model.model_identifier}" 已存在于配置中`
          });
        }

        // 检查是否有同名模型（基于 name）
        if (modelNames.has(model.name)) {
          return reply.code(400).send({
            error: `不允许绑定同名模型: 模型名称 "${model.name}" 已存在于配置中`
          });
        }

        modelIdentifiers.add(model.model_identifier);
        modelNames.add(model.name);
      }
    }

    if (body.providerId) {
      const provider = await providerDb.getById(body.providerId);
      if (!provider) {
        return reply.code(400).send({ error: '提供商不存在' });
      }
    }

    let keyValue: string;
    if (body.keyType === 'auto') {
      keyValue = `vk_${nanoid(21)}`;
    } else {
      if (!body.customKey) {
        return reply.code(400).send({ error: '自定义密钥值不能为空' });
      }

      const validation = validateCustomKey(body.customKey);
      if (!validation.valid) {
        return reply.code(400).send({ error: validation.message });
      }

      const existing = await virtualKeyDb.getByKeyValue(body.customKey);
      if (existing) {
        return reply.code(400).send({ error: '密钥值已存在' });
      }

      keyValue = body.customKey;
    }

    let vk;
    try {
      vk = await virtualKeyDb.create({
        id: nanoid(),
        key_value: keyValue,
        key_hash: hashKey(keyValue),
      name: body.name,
      provider_id: body.providerId || null,
      model_id: body.modelId || null,
      routing_strategy: body.routingStrategy || 'single',
      model_ids: body.modelIds ? JSON.stringify(body.modelIds) : null,
      routing_config: body.routingConfig ? JSON.stringify(body.routingConfig) : null,
      enabled: body.enabled !== false ? 1 : 0,
      rate_limit: body.rateLimit || null,
      cache_enabled: body.cacheEnabled ? 1 : 0,
      disable_logging: body.disableLogging ? 1 : 0,
      context_budget_tokens: body.contextBudgetTokens ?? null,
      image_compression_enabled: body.imageCompressionEnabled ? 1 : 0,
      intercept_zero_temperature: body.interceptZeroTemperature ? 1 : 0,
      zero_temperature_replacement: body.zeroTemperatureReplacement ?? null,
      pii_protection_enabled: body.piiProtectionEnabled ? 1 : 0,
        context_normalization_enabled: body.contextNormalizationEnabled ? 1 : 0,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return reply.code(400).send({ error: '密钥值已存在' });
      }
      throw error;
    }

    return {
      virtualKey: {
        id: vk.id,
        keyValue: maskKey(vk.key_value),
        name: vk.name,
        providerId: vk.provider_id,
        modelId: vk.model_id,
        routingStrategy: vk.routing_strategy,
        modelIds: vk.model_ids ? JSON.parse(vk.model_ids) : null,
        routingConfig: vk.routing_config ? JSON.parse(vk.routing_config) : null,
        enabled: vk.enabled === 1,
        rateLimit: vk.rate_limit,
        cacheEnabled: vk.cache_enabled === 1,
        disableLogging: vk.disable_logging === 1,
        contextBudgetTokens: vk.context_budget_tokens ?? null,
        imageCompressionEnabled: vk.image_compression_enabled === 1,
        interceptZeroTemperature: vk.intercept_zero_temperature === 1,
        zeroTemperatureReplacement: vk.zero_temperature_replacement != null ? Number(vk.zero_temperature_replacement) : null,
        piiProtectionEnabled: vk.pii_protection_enabled === 1,
        contextNormalizationEnabled: vk.context_normalization_enabled === 1,
        createdAt: vk.created_at,
        updatedAt: vk.updated_at,
      },
      keyValue: vk.key_value,
    };
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateVirtualKeySchema.parse(request.body);

    const vk = await virtualKeyDb.getById(id);
    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    if (body.modelId) {
      const model = await modelDb.getById(body.modelId);
      if (!model) {
        return reply.code(400).send({ error: '模型不存在' });
      }
    }

    if (body.modelIds && body.modelIds.length > 0) {
      const modelIdentifiers = new Set<string>();
      const modelNames = new Set<string>();

      for (const modelId of body.modelIds) {
        const model = await modelDb.getById(modelId);
        if (!model) {
          return reply.code(400).send({ error: `模型 ${modelId} 不存在` });
        }

        // 检查是否有同名模型（基于 model_identifier）
        if (modelIdentifiers.has(model.model_identifier)) {
          return reply.code(400).send({
            error: `不允许绑定同名模型: 模型标识 "${model.model_identifier}" 已存在于配置中`
          });
        }

        // 检查是否有同名模型（基于 name）
        if (modelNames.has(model.name)) {
          return reply.code(400).send({
            error: `不允许绑定同名模型: 模型名称 "${model.name}" 已存在于配置中`
          });
        }

        modelIdentifiers.add(model.model_identifier);
        modelNames.add(model.name);
      }
    }

    if (body.providerId !== undefined) {
      const provider = await providerDb.getById(body.providerId);
      if (!provider) {
        return reply.code(400).send({ error: '提供商不存在' });
      }
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.providerId !== undefined) updates.provider_id = body.providerId;
    if (body.modelId !== undefined) updates.model_id = body.modelId;
    if (body.routingStrategy !== undefined) updates.routing_strategy = body.routingStrategy;
    if (body.modelIds !== undefined) {
      updates.model_ids = JSON.stringify(body.modelIds);
      // The legacy model_id pin outranks model_ids in routes/proxy/model-resolver.ts.
      // Drop it only when the caller actually removed that model: clearing an untouched
      // pin would silently turn "always serve the pinned model" into "match the requested
      // model name", and clients relying on the override would get model_not_found.
      if (body.modelId === undefined && vk.model_id && !body.modelIds.includes(vk.model_id)) {
        updates.model_id = null;
      }
    }
    if (body.routingConfig !== undefined) updates.routing_config = JSON.stringify(body.routingConfig);
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
    if (body.rateLimit !== undefined) updates.rate_limit = body.rateLimit;
    if (body.cacheEnabled !== undefined) updates.cache_enabled = body.cacheEnabled ? 1 : 0;
    if (body.disableLogging !== undefined) updates.disable_logging = body.disableLogging ? 1 : 0;
    if (body.contextBudgetTokens !== undefined) updates.context_budget_tokens = body.contextBudgetTokens;
    if (body.imageCompressionEnabled !== undefined) updates.image_compression_enabled = body.imageCompressionEnabled ? 1 : 0;
    if (body.interceptZeroTemperature !== undefined) updates.intercept_zero_temperature = body.interceptZeroTemperature ? 1 : 0;
    if (body.zeroTemperatureReplacement !== undefined) updates.zero_temperature_replacement = body.zeroTemperatureReplacement;
    if (body.piiProtectionEnabled !== undefined) updates.pii_protection_enabled = body.piiProtectionEnabled ? 1 : 0;
    if (body.contextNormalizationEnabled !== undefined) updates.context_normalization_enabled = body.contextNormalizationEnabled ? 1 : 0;

    await virtualKeyDb.update(id, updates);
    hotConfigCache.invalidateVirtualKey(vk.key_value);

    const updated = await virtualKeyDb.getById(id);
    if (!updated) {
      throw new Error('虚拟密钥不存在');
    }

    return {
      id: updated.id,
      keyValue: updated.key_value,
      name: updated.name,
      providerId: updated.provider_id,
      modelId: updated.model_id,
      routingStrategy: updated.routing_strategy,
      modelIds: updated.model_ids ? JSON.parse(updated.model_ids) : null,
      routingConfig: updated.routing_config ? JSON.parse(updated.routing_config) : null,
      enabled: updated.enabled === 1,
      rateLimit: updated.rate_limit,
      cacheEnabled: updated.cache_enabled === 1,
      disableLogging: updated.disable_logging === 1,
      contextBudgetTokens: updated.context_budget_tokens ?? null,
      imageCompressionEnabled: updated.image_compression_enabled === 1,
      interceptZeroTemperature: updated.intercept_zero_temperature === 1,
      zeroTemperatureReplacement: updated.zero_temperature_replacement != null ? Number(updated.zero_temperature_replacement) : null,
      piiProtectionEnabled: updated.pii_protection_enabled === 1,
      contextNormalizationEnabled: updated.context_normalization_enabled === 1,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.post('/:id/rotate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = rotateVirtualKeySchema.parse(request.body);

    const vk = await virtualKeyDb.getById(id);
    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    let keyValue: string;
    if (body.keyType === 'auto') {
      keyValue = `vk_${nanoid(21)}`;
    } else {
      if (!body.customKey) {
        return reply.code(400).send({ error: '自定义密钥值不能为空' });
      }

      const validation = validateCustomKey(body.customKey);
      if (!validation.valid) {
        return reply.code(400).send({ error: validation.message });
      }

      const existing = await virtualKeyDb.getByKeyValue(body.customKey);
      if (existing) {
        return reply.code(400).send({ error: '密钥值已存在' });
      }

      keyValue = body.customKey;
    }

    let updated;
    try {
      updated = await virtualKeyDb.rotate(id, keyValue, hashKey(keyValue));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return reply.code(400).send({ error: '密钥值已存在' });
      }
      throw error;
    }
    if (!updated) {
      throw new Error('虚拟密钥不存在');
    }

    // 旧值缓存不清除的话，旧密钥在缓存 TTL 内仍可通过认证
    hotConfigCache.invalidateVirtualKey(vk.key_value);

    return {
      keyValue: updated.key_value,
      updatedAt: updated.updated_at,
    };
  });

  // 静态段必须先于 /:id 注册，否则会被参数路由吞掉；实际路径带管理前缀：
  // GET /api/admin/virtual-keys/quotas?virtualKeyId=<id>。
  fastify.get('/quotas', async (request, reply) => {
    const { virtualKeyId } = request.query as { virtualKeyId?: string };
    if (!virtualKeyId) {
      return reply.code(400).send({ error: '缺少 virtualKeyId 查询参数' });
    }

    const vk = await virtualKeyDb.getById(virtualKeyId);
    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    const quotas = await virtualKeyQuota.snapshot(virtualKeyId);
    return { quotas };
  });

  // 实际路径 PUT /api/admin/virtual-keys/quotas/bulk。
  fastify.put('/quotas/bulk', async (request, reply) => {
    const body = quotaBulkSchema.parse(request.body);

    const seenModels = new Set<string>();
    for (const entry of body.quotas) {
      if (seenModels.has(entry.model)) {
        return reply.code(400).send({ error: `模型 ${entry.model} 在请求中重复出现` });
      }
      seenModels.add(entry.model);
    }

    const missing: string[] = [];
    for (const id of body.virtualKeyIds) {
      if (!(await virtualKeyDb.getById(id))) missing.push(id);
    }
    if (missing.length > 0) {
      return reply.code(400).send({ error: `虚拟密钥不存在: ${missing.join(', ')}` });
    }

    // 与旧全局额度一致，最多保留 3 位小数，避免浮点尾数入库。
    const quotas = body.quotas.map((entry) => ({
      model: entry.model,
      limitMillions:
        entry.limitMillions === null
          ? null
          : Math.round(entry.limitMillions * 1000) / 1000,
    }));

    await virtualKeyQuota.applyBulkQuotas(body.virtualKeyIds, quotas);

    memoryLogger.info(
      `虚拟密钥模型额度已更新 | keys: ${body.virtualKeyIds.length} 个 | ${
        quotas.map((q) => `${q.model}=${q.limitMillions === null ? '删除' : `${q.limitMillions}M`}`).join(', ') || '(空)'
      }`,
      'Quota',
    );

    return { success: true };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const vk = await virtualKeyDb.getById(id);
    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    // 两表清理必须同生共死：不包事务的话，中途失败会留下孤儿 session 绑定。
    await withTransaction(async (connection) => {
      await virtualKeyDb.delete(id, connection);
      await contextNormalizationDb.deleteBindingsByScope(id, connection);
    });
    hotConfigCache.invalidateVirtualKey(vk.key_value);

    return { success: true };
  });
}
