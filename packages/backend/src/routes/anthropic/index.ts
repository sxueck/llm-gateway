import { FastifyInstance } from 'fastify';
import { createAnthropicProxyHandler } from './proxy-handler.js';

export async function anthropicRoutes(fastify: FastifyInstance) {
  const handler = createAnthropicProxyHandler();
  fastify.post('/messages', handler);
  fastify.post('/v1/messages', handler);
}
