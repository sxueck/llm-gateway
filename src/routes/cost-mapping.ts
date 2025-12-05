import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { costMappingDb } from '../db/index.js';
import { costMappingService } from '../services/cost-mapping.js';

const CostMappingSchema = z.object({
  pattern: z.string().min(1),
  target_model: z.string().min(1),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
});

export async function costMappingRoutes(fastify: FastifyInstance) {
  // Get all mappings
  fastify.get('/', async (request, reply) => {
    try {
      const mappings = await costMappingDb.getAll();
      return mappings;
    } catch (error: any) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch cost mappings' });
    }
  });

  // Create a new mapping
  fastify.post('/', async (request, reply) => {
    try {
      const data = CostMappingSchema.parse(request.body);
      
      const mapping = {
        id: uuidv4(),
        ...data,
        enabled: data.enabled ? 1 : 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      await costMappingDb.create(mapping);
      return mapping;
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: error.errors });
      }
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to create cost mapping' });
    }
  });

  // Update a mapping
  fastify.put('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const data = CostMappingSchema.partial().parse(request.body);

      const existing = await costMappingDb.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'Cost mapping not found' });
      }

      const updateData: any = { ...data };
      if (data.enabled !== undefined) {
        updateData.enabled = data.enabled ? 1 : 0;
      }

      await costMappingDb.update(id, updateData);
      return { ...existing, ...updateData, updated_at: Date.now() };
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: error.errors });
      }
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to update cost mapping' });
    }
  });

  // Delete a mapping
  fastify.delete('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await costMappingDb.delete(id);
      return { success: true };
    } catch (error: any) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to delete cost mapping' });
    }
  });

  // Resolve cost for a model name
  fastify.post('/resolve', async (request, reply) => {
    try {
      const { model } = request.body as { model: string };
      if (!model) {
        return reply.code(400).send({ error: 'Model name is required' });
      }

      const result = await costMappingService.resolveModelCost(model);
      if (result) {
        return result;
      }

      return reply.code(404).send({ error: 'No cost information found for this model' });
    } catch (error: any) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Failed to resolve model cost' });
    }
  });
}