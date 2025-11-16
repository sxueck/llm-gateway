import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { providerDb } from '../db/index.js';
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js';
import { buildModelsEndpoint } from '../utils/api-endpoint-builder.js';

const protocolMappingSchema = z.object({
  openai: z.string().url().optional(),
  anthropic: z.string().url().optional(),
  google: z.string().url().optional(),
}).optional();

const createProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  protocolMappings: protocolMappingSchema,
  apiKey: z.string(),
  modelMapping: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const updateProviderSchema = z.object({
  name: z.string().optional(),
  baseUrl: z.string().url().optional(),
  protocolMappings: protocolMappingSchema,
  apiKey: z.string().optional(),
  modelMapping: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const batchImportSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string().url(),
    apiKey: z.string(),
    enabled: z.boolean().optional(),
  })),
  skipExisting: z.boolean().optional(),
});

export async function providerRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    const providers = await providerDb.getAll();
    return {
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.base_url,
        protocolMappings: p.protocol_mappings ? JSON.parse(p.protocol_mappings) : null,
        apiKey: '***',
        modelMapping: p.model_mapping ? JSON.parse(p.model_mapping) : null,
        enabled: p.enabled === 1,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    };
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { includeApiKey } = request.query as { includeApiKey?: string };
    const provider = await providerDb.getById(id);

    if (!provider) {
      return reply.code(404).send({ error: '提供商不存在' });
    }

    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.base_url,
      protocolMappings: provider.protocol_mappings ? JSON.parse(provider.protocol_mappings) : null,
      apiKey: includeApiKey === 'true' ? decryptApiKey(provider.api_key) : '***',
      modelMapping: provider.model_mapping ? JSON.parse(provider.model_mapping) : null,
      enabled: provider.enabled === 1,
      createdAt: provider.created_at,
      updatedAt: provider.updated_at,
    };
  });

  fastify.post('/', async (request, reply) => {
    const body = createProviderSchema.parse(request.body);

    const existing = await providerDb.getById(body.id);
    if (existing) {
      return reply.code(400).send({ error: '提供商 ID 已存在' });
    }

    const provider = await providerDb.create({
      id: body.id,
      name: body.name,
      base_url: body.baseUrl,
      protocol_mappings: body.protocolMappings ? JSON.stringify(body.protocolMappings) : null,
      api_key: encryptApiKey(body.apiKey),
      model_mapping: body.modelMapping ? JSON.stringify(body.modelMapping) : null,
      enabled: body.enabled !== false ? 1 : 0,
    });

    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.base_url,
      protocolMappings: provider.protocol_mappings ? JSON.parse(provider.protocol_mappings) : null,
      modelMapping: provider.model_mapping ? JSON.parse(provider.model_mapping) : null,
      enabled: provider.enabled === 1,
      createdAt: provider.created_at,
      updatedAt: provider.updated_at,
    };
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateProviderSchema.parse(request.body);

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: '提供商不存在' });
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.baseUrl !== undefined) updates.base_url = body.baseUrl;
    if (body.protocolMappings !== undefined) updates.protocol_mappings = body.protocolMappings ? JSON.stringify(body.protocolMappings) : null;
    if (body.apiKey !== undefined) updates.api_key = encryptApiKey(body.apiKey);
    if (body.modelMapping !== undefined) updates.model_mapping = JSON.stringify(body.modelMapping);
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;

    await providerDb.update(id, updates);

    const updated = await providerDb.getById(id);
    if (!updated) {
      throw new Error('提供商不存在');
    }

    return {
      id: updated.id,
      name: updated.name,
      baseUrl: updated.base_url,
      protocolMappings: updated.protocol_mappings ? JSON.parse(updated.protocol_mappings) : null,
      modelMapping: updated.model_mapping ? JSON.parse(updated.model_mapping) : null,
      enabled: updated.enabled === 1,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: '提供商不存在' });
    }

    await providerDb.delete(id);

    return { success: true };
  });

  fastify.post('/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };

    const provider = await providerDb.getById(id);
    if (!provider) {
      return reply.code(404).send({ error: '提供商不存在' });
    }

    try {
      const apiKey = decryptApiKey(provider.api_key);
      const endpoint = buildModelsEndpoint(provider.base_url);

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      return {
        success: response.ok,
        status: response.status,
        message: response.ok ? '连接成功' : '连接失败',
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || '连接失败',
      };
    }
  });

  fastify.post('/fetch-models', async (request, reply) => {
    const { baseUrl, apiKey } = request.body as { baseUrl: string; apiKey: string };

    if (!baseUrl || !apiKey) {
      return reply.code(400).send({ error: 'baseUrl 和 apiKey 是必需的' });
    }

    try {
      const endpoint = buildModelsEndpoint(baseUrl);

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return {
          success: false,
          message: `获取模型列表失败: HTTP ${response.status}`,
          models: [],
        };
      }

      const data: any = await response.json();
      const models = data?.data?.map((model: any) => ({
        id: model.id,
        name: model.id,
        created: model.created,
      })) || [];

      return {
        success: true,
        message: `成功获取 ${models.length} 个模型`,
        models,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || '获取模型列表失败',
        models: [],
      };
    }
  });

  fastify.post('/batch-import', async (request, reply) => {
    const body = batchImportSchema.parse(request.body);
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
              error: '提供商 ID 已存在',
            });
            results.failed++;
            continue;
          }
        }

        await providerDb.create({
          id: providerData.id,
          name: providerData.name,
          base_url: providerData.baseUrl,
          protocol_mappings: null,
          api_key: encryptApiKey(providerData.apiKey),
          model_mapping: null,
          enabled: providerData.enabled !== false ? 1 : 0,
        });

        results.success++;
      } catch (error: any) {
        results.errors.push({
          id: providerData.id,
          error: error.message || '创建失败',
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

