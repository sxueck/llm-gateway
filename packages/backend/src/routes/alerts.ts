import { FastifyInstance } from 'fastify';
import { collectAlerts } from '../services/alerts.js';
import { alertReadDb } from '../db/index.js';

/**
 * 系统告警接口：头部铃铛轮询 + 全部已读。
 * 告警本身按当前环境实时算出、不落库；已读状态按用户落在 alert_reads（键为告警 code）。
 * GET 只返回未读告警；POST /read 由服务端把当前活跃告警整体标记为该用户已读，
 * 前端不感知任何持久化细节。
 */
export async function alertRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async (request) => {
    const { fresh } = request.query as { fresh?: string };
    const [alerts, readCodes] = await Promise.all([
      collectAlerts({ fresh: fresh === '1' }),
      alertReadDb.getReadCodes(request.user.userId),
    ]);
    const unread = alerts.filter(alert => !readCodes.has(alert.code));
    return {
      generatedAt: Date.now(),
      count: unread.length,
      errors: unread.filter(alert => alert.level === 'error').length,
      alerts: unread,
    };
  });

  fastify.post('/read', async (request) => {
    const alerts = await collectAlerts();
    const marked = await alertReadDb.markRead(
      request.user.userId,
      alerts.map(alert => alert.code),
    );
    return { marked };
  });
}
