import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { expertRoutingConfigDb, expertRoutingLogDb, modelDb, systemConfigDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { expertTemplates } from '../data/expert-templates.js';

const expertTargetSchema = z.object({
  id: z.string(),
  category: z.string(),
  type: z.enum(['virtual', 'real']),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  system_prompt: z.string().optional(),
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
  enable_structured_output: z.boolean().optional(),
});

const fallbackConfigSchema = z.object({
  type: z.enum(['virtual', 'real']),
  model_id: z.string().optional(),
  provider_id: z.string().optional(),
  model: z.string().optional(),
}).optional();

const preprocessingSchema = z
  .object({
    strip_tools: z.boolean().optional(),
    strip_files: z.boolean().optional(),
    strip_code_blocks: z.boolean().optional(),
    strip_system_prompt: z.boolean().optional(),
  })
  .optional();

const routingSchema = z
  .object({
    // Backend runtime currently supports 'llm' | 'semantic' | 'hybrid'.
    // The UI may use 'pipeline' to represent the same hybrid flow.
    mode: z.enum(['llm', 'semantic', 'hybrid', 'pipeline']).optional(),
    semantic: z
        .object({
        model: z.enum(['bge-small-zh-v1.5', 'all-MiniLM-L6-v2', 'bge-m3']).optional(),
        threshold: z.number().optional(),
        margin: z.number().optional(),
        routes: z
          .array(
            z.object({
              category: z.string(),
              utterances: z.array(z.string()),
            })
          )
          .optional(),
      })
      .optional(),
    heuristics: z
      .object({
        rules: z.array(
          z.object({
            id: z.string(),
            type: z.enum(['keyword', 'regex', 'header']),
            pattern: z.string(),
            target_expert: z.string(),
          })
        ),
      })
      .optional(),
  })
  .optional();

const createExpertRoutingSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  classifier: classifierConfigSchema,
  preprocessing: preprocessingSchema,
  routing: routingSchema,
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
  preprocessing: preprocessingSchema,
  routing: routingSchema,
  experts: z.array(expertTargetSchema).optional(),
  fallback: fallbackConfigSchema,
});

async function validateModelConfig(config: any, configType: string): Promise<void> {
  if (config.type === 'virtual') {
    if (!config.model_id) {
      throw new Error(`${configType}虚拟模型未指定 model_id`);
    }

    const virtualModel = await modelDb.getById(config.model_id);
    if (!virtualModel) {
      throw new Error(`${configType}虚拟模型不存在: ${config.model_id}`);
    }

    if (!virtualModel.enabled) {
      throw new Error(`${configType}虚拟模型 "${virtualModel.name}" 已被禁用`);
    }
  } else {
    if (!config.provider_id) {
      throw new Error(`${configType}真实模型未指定 provider_id`);
    }
    if (!config.model) {
      throw new Error(`${configType}真实模型未指定 model`);
    }
  }
}

async function validateClassifierConfig(classifier: any): Promise<void> {
  await validateModelConfig(classifier, '分类器');

  if (classifier.type === 'virtual') {
    const virtualModel = await modelDb.getById(classifier.model_id);

    if (virtualModel!.expert_routing_id) {
      throw new Error(
        `分类器不能使用专家路由虚拟模型 "${virtualModel!.name}"。` +
        `分类器需要直接调用 LLM API,请使用真实模型或智能路由虚拟模型。`
      );
    }

    if (!virtualModel!.routing_config_id && !virtualModel!.provider_id) {
      throw new Error(
        `分类器虚拟模型 "${virtualModel!.name}" 没有配置智能路由或供应商。` +
        `请为该模型配置供应商或智能路由。`
      );
    }
  }
}

async function validateExpertConfig(expert: any, currentExpertRoutingId?: string): Promise<void> {
  await validateModelConfig(expert, `专家 "${expert.category}"`);

  if (expert.type === 'virtual') {
    const virtualModel = await modelDb.getById(expert.model_id);

    if (virtualModel!.expert_routing_id) {
      if (currentExpertRoutingId && virtualModel!.expert_routing_id === currentExpertRoutingId) {
        throw new Error(
          `专家 "${expert.category}" 的虚拟模型 "${virtualModel!.name}" 引用了当前专家路由配置,会导致循环依赖。` +
          `请选择其他模型。`
        );
      }
    }
  }
}

async function validateFallbackConfig(fallback: any, currentExpertRoutingId?: string): Promise<void> {
  await validateModelConfig(fallback, '降级');

  if (fallback.type === 'virtual') {
    const virtualModel = await modelDb.getById(fallback.model_id);

    if (virtualModel!.expert_routing_id) {
      if (currentExpertRoutingId && virtualModel!.expert_routing_id === currentExpertRoutingId) {
        throw new Error(
          `降级虚拟模型 "${virtualModel!.name}" 引用了当前专家路由配置,会导致循环依赖。` +
          `请选择其他模型。`
        );
      }
    }
  }
}

async function validateExpertRoutingConfig(config: any, currentExpertRoutingId?: string): Promise<void> {
  await validateClassifierConfig(config.classifier);

  for (const expert of config.experts) {
    await validateExpertConfig(expert, currentExpertRoutingId);
  }

  if (config.fallback) {
    await validateFallbackConfig(config.fallback, currentExpertRoutingId);
  }
}

export async function expertRoutingRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

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
    if (typeof req === 'string') {
      if (req === 'l1_semantic' || req === 'l2_llm' || req === 'l3_llm' || req === 'fallback') return req;
      if (req.startsWith('l1_') || req.startsWith('l2_') || req.startsWith('l3_')) return req;
    }

    const model = String(log?.classifier_model || '');
    if (model === 'fallback') return 'fallback';
    if (model === 'heuristic') return 'l2_heuristic';
    if (model.startsWith('semantic/')) return 'l1_semantic';
    return 'l2_llm';
  }

  function inferSemanticScore(log: any): number | undefined {
    if (log?.semantic_score !== undefined && log?.semantic_score !== null) {
      const n = Number(log.semantic_score);
      return Number.isFinite(n) ? n : undefined;
    }
    const source = inferRouteSource(log);
    if (source !== 'l1_semantic') return undefined;
    try {
      const parsed = safeJsonParse(log?.classifier_response);
      const score = parsed?.top1?.score;
      const n = Number(score);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }

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

  // Expert templates are served from backend so the frontend doesn't hardcode them.
  fastify.get('/templates', async () => {
    return { templates: expertTemplates };
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
        preprocessing: body.preprocessing,
        routing: body.routing,
        experts: body.experts,
        fallback: body.fallback,
      };

      await validateExpertRoutingConfig(configData);

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
          protocol: null,
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
      if (
        body.classifier ||
        body.experts ||
        body.fallback !== undefined ||
        body.routing !== undefined ||
        body.preprocessing !== undefined
      ) {
        const currentConfig = JSON.parse(existingConfig.config);

        configData = {
          classifier: body.classifier || currentConfig.classifier,
          preprocessing: body.preprocessing !== undefined ? body.preprocessing : currentConfig.preprocessing,
          routing: body.routing !== undefined ? body.routing : currentConfig.routing,
          experts: body.experts || currentConfig.experts,
          fallback: body.fallback !== undefined ? body.fallback : currentConfig.fallback,
        };

        await validateExpertRoutingConfig(configData, id);
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

      const existingConfig = await expertRoutingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error('专家路由配置不存在');
      }

      const associatedModels = await modelDb.getByExpertRoutingId(id);
      let deletedModels = 0;
      let detachedModels = 0;

      for (const model of associatedModels) {
        const shouldDelete = model.is_virtual === 1 && model.model_identifier === `expert-${id}`;
        if (shouldDelete) {
          await modelDb.delete(model.id);
          deletedModels++;
        } else {
          await modelDb.update(model.id, { expert_routing_id: null });
          detachedModels++;
        }
      }

      await expertRoutingConfigDb.delete(id);
      memoryLogger.info(
        `删除专家路由配置: ${id} | 删除专家模型: ${deletedModels} 个 | 解绑模型: ${detachedModels} 个`,
        'ExpertRouting'
      );
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
      const routeStats = await expertRoutingLogDb.getRouteStats(id, timeRangeMs);

      const categoryDistribution: Record<string, number> = {};
      let totalRequests = 0;
      let totalClassificationTime = 0;

      for (const row of stats as any[]) {
        categoryDistribution[row.classification_result] = Number(row.count);
        totalRequests += Number(row.count);
        totalClassificationTime += Number(row.avg_time) * Number(row.count);
      }

      const routeSourceDistribution: Record<string, number> = {};
      let totalCleanedLength = 0;
      let totalPromptTokens = 0;
      let cleaningCount = 0;

      if ((routeStats as any[]).length > 0) {
        for (const row of routeStats as any[]) {
          if (row.route_source) {
            routeSourceDistribution[row.route_source] = Number(row.count);
          }
          const count = Number(row.count);
          totalCleanedLength += Number(row.avg_cleaned_length || 0) * count;
          totalPromptTokens += Number(row.avg_prompt_tokens || 0) * count;
          cleaningCount += count;
        }
      } else {
        // Fallback when stats columns (route_source/prompt_tokens/cleaned_content_length) are missing.
        const modelStats = await expertRoutingLogDb.getClassifierModelStats(id, timeRangeMs);
        for (const row of modelStats as any[]) {
          const model = String(row.classifier_model || '');
          const count = Number(row.count);
          const source =
            model === 'fallback'
              ? 'fallback'
              : model === 'heuristic'
                ? 'l2_heuristic'
                : model.startsWith('semantic/')
                  ? 'l1_semantic'
                  : 'l2_llm';
          routeSourceDistribution[source] = (routeSourceDistribution[source] || 0) + count;
        }
      }

      const cleaningStats = {
        avgPromptTokens: cleaningCount > 0 ? Math.round(totalPromptTokens / cleaningCount) : 0,
        avgCleanedLength: cleaningCount > 0 ? Math.round(totalCleanedLength / cleaningCount) : 0,
        totalRequests: cleaningCount
      };

      const avgClassificationTime = totalRequests > 0
        ? Math.round(totalClassificationTime / totalRequests)
        : 0;

      return {
        totalRequests,
        avgClassificationTime,
        categoryDistribution,
        routeSourceDistribution,
        cleaningStats
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
      const logs = (await expertRoutingLogDb.getByConfigId(id, limitNum) as any[]).map((log) => ({
        ...log,
        route_source: inferRouteSource(log),
        semantic_score: inferSemanticScore(log),
      }));

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
      const logs = (await expertRoutingLogDb.getByCategory(id, category, limitNum) as any[]).map((log) => ({
        ...log,
        route_source: inferRouteSource(log),
        semantic_score: inferSemanticScore(log),
      }));

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
        prompt_tokens: log.prompt_tokens ?? undefined,
        cleaned_content_length: log.cleaned_content_length ?? undefined,
        semantic_score: inferSemanticScore(log),
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
