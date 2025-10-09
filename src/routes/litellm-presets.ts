import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { litellmPresetsService } from '../services/litellm-presets.js';

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(100).optional(),
});

export async function litellmPresetsRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/stats', async () => {
    await litellmPresetsService.ensureDataAvailable();
    const stats = litellmPresetsService.getStats();
    return stats;
  });

  fastify.post('/update', async (request, reply) => {
    const result = await litellmPresetsService.updateFromRemote();
    
    if (result.success) {
      return result;
    } else {
      return reply.code(500).send({ error: result.message });
    }
  });

  fastify.post('/search', async (request, reply) => {
    const body = searchSchema.parse(request.body);
    
    await litellmPresetsService.ensureDataAvailable();
    
    const results = litellmPresetsService.searchModels(body.query, body.limit);
    
    return {
      query: body.query,
      results: results.map(r => ({
        modelName: r.modelName,
        provider: r.info.litellm_provider,
        maxTokens: r.info.max_tokens,
        maxInputTokens: r.info.max_input_tokens,
        maxOutputTokens: r.info.max_output_tokens,
        inputCost: r.info.input_cost_per_token,
        outputCost: r.info.output_cost_per_token,
        supportsVision: r.info.supports_vision,
        supportsFunctionCalling: r.info.supports_function_calling,
        score: r.score,
      })),
      total: results.length,
    };
  });

  fastify.get('/model/:modelName', async (request, reply) => {
    const { modelName } = request.params as { modelName: string };
    
    await litellmPresetsService.ensureDataAvailable();
    
    const info = litellmPresetsService.getModelInfo(modelName);
    
    if (!info) {
      return reply.code(404).send({ error: '模型未找到' });
    }

    const attributes = litellmPresetsService.convertToModelAttributes(info);
    
    return {
      modelName,
      rawInfo: info,
      attributes,
    };
  });
}

