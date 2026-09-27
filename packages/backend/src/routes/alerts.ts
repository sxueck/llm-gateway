import { FastifyInstance } from 'fastify';
import { collectAlerts } from '../services/alerts.js';

/**
 * 系统告警只读接口：头部铃铛轮询用。
 * 告警按当前环境实时算出，不落库，因此没有已读/删除语义——条件消失即消失。
 */
export async function alertRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async (request) => {
    const { fresh } = request.query as { fresh?: string };
    const alerts = await collectAlerts({ fresh: fresh === '1' });
    return {
      generatedAt: Date.now(),
      count: alerts.length,
      errors: alerts.filter(alert => alert.level === 'error').length,
      alerts,
    };
  });
}
