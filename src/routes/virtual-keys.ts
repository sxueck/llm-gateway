import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { virtualKeyDb, providerDb, modelDb } from '../db/index.js';
import { hashKey } from '../utils/crypto.js';
import { validateCustomKey } from '../utils/validation.js';

const createVirtualKeySchema = z.object({
  name: z.string(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  routingStrategy: z.enum(['single', 'load-balance', 'failover']).optional(),
  modelIds: z.array(z.string()).optional(),
  routingConfig: z.record(z.any()).optional(),
  keyType: z.enum(['auto', 'custom']),
  customKey: z.string().optional(),
  rateLimit: z.number().optional(),
  enabled: z.boolean().optional(),
  cacheEnabled: z.boolean().optional(),
  disableLogging: z.boolean().optional(),
});

const updateVirtualKeySchema = z.object({
  name: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  routingStrategy: z.string().optional(),
  modelIds: z.array(z.string()).optional(),
  routingConfig: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
  rateLimit: z.number().optional(),
  cacheEnabled: z.boolean().optional(),
  disableLogging: z.boolean().optional(),
});

const validateKeySchema = z.object({
  customKey: z.string(),
});

export async function virtualKeyRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    const virtualKeys = await virtualKeyDb.getAll();
    return {
      virtualKeys: virtualKeys.map(vk => ({
        id: vk.id,
        keyValue: vk.key_value,
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
      keyValue: vk.key_value,
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
      for (const modelId of body.modelIds) {
        const model = await modelDb.getById(modelId);
        if (!model) {
          return reply.code(400).send({ error: `模型 ${modelId} 不存在` });
        }
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

    const vk = await virtualKeyDb.create({
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
    });

    return {
      virtualKey: {
        id: vk.id,
        keyValue: vk.key_value,
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

    if (body.modelId !== undefined) {
      const model = await modelDb.getById(body.modelId);
      if (!model) {
        return reply.code(400).send({ error: '模型不存在' });
      }
    }

    if (body.modelIds && body.modelIds.length > 0) {
      for (const modelId of body.modelIds) {
        const model = await modelDb.getById(modelId);
        if (!model) {
          return reply.code(400).send({ error: `模型 ${modelId} 不存在` });
        }
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
    if (body.modelIds !== undefined) updates.model_ids = JSON.stringify(body.modelIds);
    if (body.routingConfig !== undefined) updates.routing_config = JSON.stringify(body.routingConfig);
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
    if (body.rateLimit !== undefined) updates.rate_limit = body.rateLimit;
    if (body.cacheEnabled !== undefined) updates.cache_enabled = body.cacheEnabled ? 1 : 0;
    if (body.disableLogging !== undefined) updates.disable_logging = body.disableLogging ? 1 : 0;

    await virtualKeyDb.update(id, updates);

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
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const vk = await virtualKeyDb.getById(id);
    if (!vk) {
      return reply.code(404).send({ error: '虚拟密钥不存在' });
    }

    await virtualKeyDb.delete(id);

    return { success: true };
  });

  fastify.post('/validate', async (request, reply) => {
    const body = validateKeySchema.parse(request.body);

    const validation = validateCustomKey(body.customKey);
    if (!validation.valid) {
      return { valid: false, message: validation.message };
    }

    const existing = await virtualKeyDb.getByKeyValue(body.customKey);
    if (existing) {
      return { valid: false, message: '密钥值已存在' };
    }

    return { valid: true };
  });
}

