import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { modelDb, providerDb, virtualKeyDb, portkeyGatewayDb } from '../db/index.js';
import { decryptApiKey } from '../utils/crypto.js';
import { portkeyRouter } from '../services/portkey-router.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}

const modelAttributesSchema = z.object({
  max_tokens: z.number().optional(),
  max_input_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  input_cost_per_token: z.number().optional(),
  output_cost_per_token: z.number().optional(),
  input_cost_per_token_cache_hit: z.number().optional(),
  supports_function_calling: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_tool_choice: z.boolean().optional(),
  supports_assistant_prefill: z.boolean().optional(),
  supports_prompt_caching: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_audio_input: z.boolean().optional(),
  supports_audio_output: z.boolean().optional(),
  supports_pdf_input: z.boolean().optional(),
  litellm_provider: z.string().optional(),
  mode: z.string().optional(),
}).optional();

const promptConfigSchema = z.object({
  operationType: z.enum(['replace', 'prepend', 'system']),
  templateContent: z.string(),
  systemMessage: z.string().optional(),
  enabled: z.boolean().optional(),
}).optional();

const createModelSchema = z.object({
  name: z.string(),
  providerId: z.string().optional(),
  modelIdentifier: z.string(),
  isVirtual: z.boolean().optional(),
  routingConfigId: z.string().optional(),
  enabled: z.boolean().optional(),
  modelAttributes: modelAttributesSchema,
  promptConfig: promptConfigSchema,
});

const updateModelSchema = z.object({
  name: z.string().optional(),
  modelIdentifier: z.string().optional(),
  enabled: z.boolean().optional(),
  modelAttributes: modelAttributesSchema,
  promptConfig: promptConfigSchema,
});

export async function modelRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    const models = modelDb.getAll();
    const providers = providerDb.getAll();
    const providerMap = new Map(providers.map(p => [p.id, p]));

    const virtualKeyCounts = virtualKeyDb.countByModelIds(models.map(m => m.id));

    return {
      models: models.map(m => {
        const provider = m.provider_id ? providerMap.get(m.provider_id) : null;
        const virtualKeyCount = virtualKeyCounts.get(m.id) || 0;

        let modelAttributes = null;
        try {
          modelAttributes = m.model_attributes ? JSON.parse(m.model_attributes) : null;
        } catch (e) {
        }

        let promptConfig = null;
        try {
          promptConfig = m.prompt_config ? JSON.parse(m.prompt_config) : null;
        } catch (e) {
        }

        let routingGateway = null;
        if (!m.is_virtual) {
          const gateway = portkeyRouter.selectGateway({
            modelName: m.name,
            modelId: m.id,
            providerId: m.provider_id || undefined,
          });

          if (gateway) {
            routingGateway = {
              id: gateway.id,
              name: gateway.name,
              url: gateway.url,
            };
          }
        }

        return {
          id: m.id,
          name: m.name,
          providerId: m.provider_id,
          providerName: m.is_virtual === 1 ? '虚拟模型' : (provider?.name || '未知提供商'),
          modelIdentifier: m.model_identifier,
          isVirtual: m.is_virtual === 1,
          routingConfigId: m.routing_config_id,
          enabled: m.enabled === 1,
          modelAttributes,
          promptConfig,
          virtualKeyCount,
          routingGateway,
          createdAt: m.created_at,
          updatedAt: m.updated_at,
        };
      }),
    };
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = modelDb.getById(id);

    if (!model) {
      return reply.code(404).send({ error: '模型不存在' });
    }

    const provider = model.provider_id ? providerDb.getById(model.provider_id) : null;
    const virtualKeyCount = virtualKeyDb.countByModelId(model.id);

    let modelAttributes = null;
    try {
      modelAttributes = model.model_attributes ? JSON.parse(model.model_attributes) : null;
    } catch (e) {
    }

    let promptConfig = null;
    try {
      promptConfig = model.prompt_config ? JSON.parse(model.prompt_config) : null;
    } catch (e) {
    }

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      providerName: model.is_virtual === 1 ? '虚拟模型' : (provider?.name || '未知提供商'),
      modelIdentifier: model.model_identifier,
      enabled: model.enabled === 1,
      modelAttributes,
      promptConfig,
      virtualKeyCount,
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
  });

  fastify.post('/', async (request, reply) => {
    const body = createModelSchema.parse(request.body);

    if (body.providerId) {
      const provider = providerDb.getById(body.providerId);
      if (!provider) {
        return reply.code(400).send({ error: '提供商不存在' });
      }
    } else if (!body.isVirtual) {
      return reply.code(400).send({ error: '非虚拟模型必须关联提供商' });
    }

    const model = await modelDb.create({
      id: nanoid(),
      name: body.name,
      provider_id: body.providerId || null,
      model_identifier: body.modelIdentifier,
      is_virtual: body.isVirtual ? 1 : 0,
      routing_config_id: body.routingConfigId || null,
      enabled: body.enabled !== false ? 1 : 0,
      model_attributes: body.modelAttributes ? JSON.stringify(body.modelAttributes) : null,
      prompt_config: body.promptConfig ? JSON.stringify(body.promptConfig) : null,
    });

    let modelAttributes = null;
    try {
      modelAttributes = model.model_attributes ? JSON.parse(model.model_attributes) : null;
    } catch (e) {
    }

    let promptConfig = null;
    try {
      promptConfig = model.prompt_config ? JSON.parse(model.prompt_config) : null;
    } catch (e) {
    }

    return {
      id: model.id,
      name: model.name,
      providerId: model.provider_id,
      modelIdentifier: model.model_identifier,
      isVirtual: model.is_virtual === 1,
      routingConfigId: model.routing_config_id,
      enabled: model.enabled === 1,
      modelAttributes,
      promptConfig,
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
  });

  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateModelSchema.parse(request.body);

    const model = modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: '模型不存在' });
    }

    const updates: any = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.modelIdentifier !== undefined) updates.model_identifier = body.modelIdentifier;
    if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
    if (body.modelAttributes !== undefined) {
      updates.model_attributes = body.modelAttributes ? JSON.stringify(body.modelAttributes) : null;
    }
    if (body.promptConfig !== undefined) {
      updates.prompt_config = body.promptConfig ? JSON.stringify(body.promptConfig) : null;
    }

    await modelDb.update(id, updates);

    const updated = modelDb.getById(id)!;
    let modelAttributes = null;
    try {
      modelAttributes = updated.model_attributes ? JSON.parse(updated.model_attributes) : null;
    } catch (e) {
    }

    let promptConfig = null;
    try {
      promptConfig = updated.prompt_config ? JSON.parse(updated.prompt_config) : null;
    } catch (e) {
    }

    return {
      id: updated.id,
      name: updated.name,
      providerId: updated.provider_id,
      modelIdentifier: updated.model_identifier,
      enabled: updated.enabled === 1,
      modelAttributes,
      promptConfig,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const model = modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: '模型不存在' });
    }

    const virtualKeyCount = virtualKeyDb.countByModelId(id);
    if (virtualKeyCount > 0) {
      return reply.code(400).send({ 
        error: `无法删除模型，有 ${virtualKeyCount} 个虚拟密钥正在使用此模型` 
      });
    }

    await modelDb.delete(id);
    return { success: true };
  });

  fastify.get('/by-provider/:providerId', async (request) => {
    const { providerId } = request.params as { providerId: string };
    const models = modelDb.getByProviderId(providerId);

    return {
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        providerId: m.provider_id,
        modelIdentifier: m.model_identifier,
        enabled: m.enabled === 1,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
      })),
    };
  });

  fastify.post('/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };

    const model = modelDb.getById(id);
    if (!model) {
      return reply.code(404).send({ error: '模型不存在' });
    }

    if (model.is_virtual === 1) {
      return reply.code(400).send({ error: '虚拟模型无法直接测试' });
    }

    const provider = providerDb.getById(model.provider_id!);
    if (!provider) {
      return reply.code(400).send({ error: '关联的提供商不存在' });
    }

    const startTime = Date.now();

    try {
      const apiKey = decryptApiKey(provider.api_key);
      const endpoint = `${provider.base_url}/chat/completions`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.model_identifier,
          messages: [{ role: 'user', content: '测试' }],
          max_tokens: 10,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          status: response.status,
          message: `测试失败: HTTP ${response.status}`,
          error: errorText,
          responseTime,
        };
      }

      const data: any = await response.json();
      const content = data?.choices?.[0]?.message?.content || '无响应内容';

      return {
        success: true,
        status: response.status,
        message: '测试成功',
        responseTime,
        response: {
          content,
          usage: data?.usage,
        },
      };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        message: error.message || '测试失败',
        responseTime,
        error: error.stack,
      };
    }
  });
}