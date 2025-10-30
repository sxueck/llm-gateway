import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { expertRoutingConfigDb, expertRoutingLogDb, modelDb, systemConfigDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';

const expertTargetSchema = z.object({
  id: z.string(),
  category: z.string(),
  type: z.enum(['virtual', 'real']),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

const classifierConfigSchema = z.object({
  type: z.enum(['virtual', 'real']),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
  prompt_template: z.string(),
  system_prompt: z.string().optional(),
  user_prompt_marker: z.string().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  timeout: z.number().optional(),
  ignore_system_messages: z.boolean().optional(),
  max_messages_to_classify: z.number().optional(),
  ignored_tags: z.array(z.string()).optional(),
});

const fallbackConfigSchema = z.object({
  type: z.enum(['virtual', 'real']),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
}).optional();

const createExpertRoutingSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  classifier: classifierConfigSchema,
  experts: z.array(expertTargetSchema),
  fallback: fallbackConfigSchema,
  createVirtualModel: z.boolean().optional(),
  virtualModelName: z.string().optional(),
  modelAttributes: z.any().optional(),
});

const updateExpertRoutingSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  classifier: classifierConfigSchema.optional(),
  experts: z.array(expertTargetSchema).optional(),
  fallback: fallbackConfigSchema,
});

export async function expertRoutingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    try {
      const configs = await expertRoutingConfigDb.getAll();
        return {
          configs: (configs as any[]).map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          enabled: c.enabled === 1,
          config: JSON.parse(c.config),
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        })),
      };
    } catch (error: any) {
      memoryLogger.error(`获取专家路由配置失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const config = await expertRoutingConfigDb.getById(id);

      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      return {
        id: config.id,
        name: config.name,
        description: config.description,
        enabled: config.enabled === 1,
        config: JSON.parse(config.config),
        createdAt: config.created_at,
        updatedAt: config.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`获取专家路由配置失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.post('/', async (request) => {
    try {
      const body = createExpertRoutingSchema.parse(request.body);

      const configData = {
        classifier: body.classifier,
        experts: body.experts,
        fallback: body.fallback,
      };

      const configId = nanoid();
      const config = await expertRoutingConfigDb.create({
        id: configId,
        name: body.name,
        description: body.description,
        enabled: body.enabled === false ? 0 : 1,
        config: JSON.stringify(configData),
      });

      memoryLogger.info(`创建专家路由配置: ${config!.name}`, 'ExpertRouting');

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
          model_attributes: body.modelAttributes ? JSON.stringify(body.modelAttributes) : null,
          prompt_config: null,
          compression_config: null,
        });
        memoryLogger.info(`创建专家模型: ${virtualModelName}`, 'ExpertRouting');
      }

      return {
        id: config!.id,
        name: config!.name,
        description: config!.description,
        enabled: config!.enabled === 1,
        config: JSON.parse(config!.config),
        createdAt: config!.created_at,
        updatedAt: config!.updated_at,
        virtualModel: virtualModel ? {
          id: virtualModel.id,
          name: virtualModel.name,
          providerId: virtualModel.provider_id,
          modelIdentifier: virtualModel.model_identifier,
          isVirtual: true,
          expertRoutingId: virtualModel.expert_routing_id,
        } : null,
      };
    } catch (error: any) {
      memoryLogger.error(`创建专家路由配置失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.put('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateExpertRoutingSchema.parse(request.body);

      const existingConfig = await expertRoutingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error('专家路由配置不存在');
      }

      let configData;
      if (body.classifier || body.experts || body.fallback !== undefined) {
        const currentConfig = JSON.parse(existingConfig.config);
        configData = {
          classifier: body.classifier || currentConfig.classifier,
          experts: body.experts || currentConfig.experts,
          fallback: body.fallback !== undefined ? body.fallback : currentConfig.fallback,
        };
      }

      await expertRoutingConfigDb.update(id, {
        name: body.name,
        description: body.description ?? undefined,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
        config: configData ? JSON.stringify(configData) : undefined,
      });

      if (body.name && body.name !== existingConfig.name) {
        const associatedModels = (await modelDb.getAll() as any[]).filter((m: any) => m.expert_routing_id === id);
        for (const model of associatedModels) {
          await modelDb.update(model.id, { name: body.name });
        }
        memoryLogger.info(`同步更新专家路由关联模型名称: ${associatedModels.length} 个`, 'ExpertRouting');
      }

      memoryLogger.info(`更新专家路由配置: ${id}`, 'ExpertRouting');

      const updatedConfig = await expertRoutingConfigDb.getById(id);
      return {
        id: updatedConfig!.id,
        name: updatedConfig!.name,
        description: updatedConfig!.description,
        enabled: updatedConfig!.enabled === 1,
        config: JSON.parse(updatedConfig!.config),
        createdAt: updatedConfig!.created_at,
        updatedAt: updatedConfig!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新专家路由配置失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.delete('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };

      const associatedModels = (await modelDb.getAll() as any[]).filter(m => m.expert_routing_id === id);
      for (const model of associatedModels) {
        await modelDb.update(model.id, { expert_routing_id: null });
      }

      await expertRoutingConfigDb.delete(id);
      memoryLogger.info(`删除专家路由配置: ${id} | 清理关联模型: ${associatedModels.length} 个`, 'ExpertRouting');
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除专家路由配置失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/:id/statistics', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { timeRange } = request.query as { timeRange?: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      const timeRangeMs = timeRange ? Number.parseInt(timeRange) : undefined;
      const stats = await expertRoutingLogDb.getStatistics(id, timeRangeMs);

      const categoryDistribution: Record<string, number> = {};
      let totalRequests = 0;
      let totalClassificationTime = 0;

      for (const row of stats as any[]) {
        categoryDistribution[row.classification_result] = Number(row.count);
        totalRequests += Number(row.count);
        totalClassificationTime += Number(row.avg_time) * Number(row.count);
      }

      const avgClassificationTime = totalRequests > 0
        ? Math.round(totalClassificationTime / totalRequests)
        : 0;

      return {
        totalRequests,
        avgClassificationTime,
        categoryDistribution,
      };
    } catch (error: any) {
      memoryLogger.error(`获取专家路由统计失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/:id/logs', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      const limitNum = limit ? Number.parseInt(limit) : 100;
      const logs = await expertRoutingLogDb.getByConfigId(id, limitNum);

      return { logs };
    } catch (error: any) {
      memoryLogger.error(`获取专家路由日志失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/:id/logs/category/:category', async (request) => {
    try {
      const { id, category } = request.params as { id: string; category: string };
      const { limit } = request.query as { limit?: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      const limitNum = limit ? Number.parseInt(limit) : 100;
      const logs = await expertRoutingLogDb.getByCategory(id, category, limitNum);

      return { logs };
    } catch (error: any) {
      memoryLogger.error(`获取分类日志失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/:id/logs/:logId/details', async (request) => {
    try {
      const { id, logId } = request.params as { id: string; logId: string };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      const log = await expertRoutingLogDb.getById(logId);
      if (!log) {
        throw new Error('日志不存在');
      }

      if (log.expert_routing_id !== id) {
        throw new Error('日志不属于该专家路由配置');
      }

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
        original_request: log.original_request ? JSON.parse(log.original_request) : null,
        classifier_request: log.classifier_request ? JSON.parse(log.classifier_request) : null,
        classifier_response: log.classifier_response ? JSON.parse(log.classifier_response) : null,
      };
    } catch (error: any) {
      memoryLogger.error(`获取日志详情失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.post('/:id/models', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const { modelIds } = request.body as { modelIds: string[] };

      const config = await expertRoutingConfigDb.getById(id);
      if (!config) {
        throw new Error('专家路由配置不存在');
      }

      for (const modelId of modelIds) {
        const model = await modelDb.getById(modelId);
        if (model) {
          await modelDb.update(modelId, {
            expert_routing_id: id,
          });
        }
      }

      memoryLogger.info(`关联模型到专家路由: ${id} | 模型数量: ${modelIds.length}`, 'ExpertRouting');

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`关联模型失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.delete('/:id/models/:modelId', async (request) => {
    try {
      const { id, modelId } = request.params as { id: string; modelId: string };

      const model = await modelDb.getById(modelId);
      if (!model) {
        throw new Error('模型不存在');
      }

      if (model.expert_routing_id !== id) {
        throw new Error('模型未关联到此专家路由');
      }

      await modelDb.update(modelId, {
        expert_routing_id: null,
      });

      memoryLogger.info(`取消模型关联: ${modelId} | 专家路由: ${id}`, 'ExpertRouting');

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`取消模型关联失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.post('/preferences/preview-width', async (request) => {
    try {
      const { width } = request.body as { width: number };

      if (typeof width !== 'number' || width < 400 || width > 1200) {
        throw new Error('无效的预览宽度');
      }

      await systemConfigDb.set('expert_routing_preview_width', String(width), '专家路由预览宽度');

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`保存预览宽度失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });

  fastify.get('/preferences/preview-width', async () => {
    try {
      const config = await systemConfigDb.get('expert_routing_preview_width');
      const width = config ? Number.parseInt(config.value, 10) : 600;

      return { width };
    } catch (error: any) {
      memoryLogger.error(`获取预览宽度失败: ${error.message}`, 'ExpertRouting');
      throw error;
    }
  });
}

