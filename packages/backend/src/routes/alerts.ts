import { FastifyInstance } from 'fastify';
import { ALERT_LEVEL_ORDER, collectAlerts, type SystemAlert } from '../services/alerts.js';
import { loginLockoutService } from '../services/login-lockout.js';
import { alertReadDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';

/**
 * 系统告警接口：头部铃铛轮询 + 全部已读。
 * 已读状态按用户落在 alert_reads（键为告警 code）；GET 只返回未读，POST /read 由服务端
 * 把当前活跃告警整体标为已读，前端不感知任何持久化细节。
 */

/**
 * 快照告警（实时算、不落库）与持久化封锁事件（每次直接读库，不经 30s 快照缓存）合并；
 * code 空间不重叠，按级别稳定排序。
 * 事件那一腿单独兜底：封锁表抖动只丢这一类告警，不能把整个铃铛和「全部已读」一起打死。
 */
async function collectVisibleAlerts(fresh: boolean): Promise<SystemAlert[]> {
  const [snapshot, security] = await Promise.allSettled([
    collectAlerts({ fresh }),
    loginLockoutService.collectAlerts(),
  ]);
  // 快照采集本身已逐项 allSettled，意外拒绝就交给上游（前端会保留上一次结果）。
  if (snapshot.status === "rejected") throw snapshot.reason;
  if (security.status === "rejected") {
    memoryLogger.warn(
      `登录封锁告警读取失败: ${security.reason?.message || security.reason}`,
      'Alerts',
    );
  }
  return [
    ...(snapshot.status === "fulfilled" ? snapshot.value : []),
    ...(security.status === "fulfilled" ? security.value : []),
  ].sort((a, b) => ALERT_LEVEL_ORDER[a.level] - ALERT_LEVEL_ORDER[b.level]);
}

export async function alertRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async (request) => {
    const { fresh } = request.query as { fresh?: string };
    const [alerts, readCodes] = await Promise.all([
      collectVisibleAlerts(fresh === '1'),
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
    const alerts = await collectVisibleAlerts(false);
    const marked = await alertReadDb.markRead(
      request.user.userId,
      alerts.map(alert => alert.code),
    );
    return { marked };
  });
}
