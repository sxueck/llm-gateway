import type { FastifyInstance } from 'fastify';
import { apiRequestDb } from '../db/index.js';

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.get('/stats', async (request, reply) => {
    const { period = '24h' } = request.query as { period?: string };
    const intervals: Record<string, number> = { '24h': 86400000, '7d': 604800000, '30d': 2592000000, all: 0 };
    if (!Object.hasOwn(intervals, period)) {
      return reply.code(400).send({ error: { message: '无效的时间范围', type: 'invalid_request_error', param: 'period', code: 'invalid_period' } });
    }
    const endTime = Date.now();
    const startTime = period === 'all' ? 0 : endTime - intervals[period];
    const { totalRequests, successfulRequests, failedRequests, totalTokens, promptTokens, completionTokens, cachedTokens, avgResponseTime, cacheHits, promptCacheHits, cacheSavedTokens, legacyTokenSemantics } = await apiRequestDb.getStats({ startTime, endTime });
    return { period, stats: { totalRequests, successfulRequests, failedRequests, totalTokens, promptTokens, completionTokens, cachedTokens, avgResponseTime, cacheHits, promptCacheHits, cacheSavedTokens, legacyTokenSemantics } };
  });
}
