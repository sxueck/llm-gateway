import { FastifyInstance } from 'fastify';
import { healthAggregatorService } from '../services/health-aggregator.js';
import { healthTargetDb, systemConfigDb } from '../db/index.js';

// 简单的内存限流器
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];

    // 清除过期的时间戳
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);

    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }
}

// 创建限流器：每分钟最多60个请求
const rateLimiter = new RateLimiter(60000, 60);

// 每10分钟清理一次限流器
setInterval(() => {
  rateLimiter.cleanup();
}, 600000);

export async function healthRoutes(fastify: FastifyInstance) {
  // 公开接口开关门控
  fastify.addHook('preHandler', async (request, reply) => {
    const persistentCfg = await systemConfigDb.get('persistent_monitoring_enabled');
    const publicCfg = await systemConfigDb.get('health_monitoring_enabled');
    const persistent = persistentCfg ? persistentCfg.value === 'true' : false;
    const publicEnabled = publicCfg ? publicCfg.value === 'true' : true;

    if (!persistent || !publicEnabled) {
      reply.code(404).send({
        error: {
          message: '健康监控未启用',
          type: 'not_found',
          code: 'health_monitoring_disabled',
        },
      });
      return;
    }
  });

  // 限流中间件
  fastify.addHook('preHandler', async (request, reply) => {
    const ip = request.ip;
    if (!rateLimiter.isAllowed(ip)) {
      reply.code(429).send({
        error: {
          message: '请求过于频繁，请稍后再试',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      });
      return;
    }
  });

  /**
   * GET /public/health/summary
   * 获取所有目标的汇总信息
   */
  fastify.get('/public/health/summary', async (request, reply) => {
    try {
      const [targets, global] = await Promise.all([
        healthAggregatorService.getAllTargetsSummary(),
        healthAggregatorService.getGlobalSummary(),
      ]);

      reply.header('Cache-Control', 'public, max-age=15');
      return {
        global,
        targets,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  /**
   * GET /public/health/targets
   * 获取目标清单
   */
  fastify.get('/public/health/targets', async (request, reply) => {
    try {
      const targets = await healthTargetDb.getEnabled();

      const targetList = targets.map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        check_interval_seconds: t.check_interval_seconds,
      }));

      reply.header('Cache-Control', 'public, max-age=60');
      return {
        targets: targetList,
        total: targetList.length,
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  /**
   * GET /public/health/detail?target_id=xxx
   * 获取单个目标的详细信息
   */
  fastify.get<{
    Querystring: { target_id?: string };
  }>('/public/health/detail', async (request, reply) => {
    try {
      const { target_id } = request.query;

      if (!target_id) {
        reply.code(400).send({
          error: {
            message: '缺少参数: target_id',
            type: 'invalid_request_error',
            code: 'missing_parameter',
          },
        });
        return;
      }

      const summary = await healthAggregatorService.getTargetSummary(target_id);

      reply.header('Cache-Control', 'public, max-age=15');
      return {
        ...summary,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      if (error.message.includes('不存在')) {
        reply.code(404).send({
          error: {
            message: error.message,
            type: 'not_found_error',
            code: 'target_not_found',
          },
        });
        return;
      }

      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  /**
   * GET /public/health/runs?target_id=xxx&window=24h&page=1&page_size=50
   * 获取目标的检查历史记录
   */
  fastify.get<{
    Querystring: {
      target_id?: string;
      window?: string;
      page?: string;
      page_size?: string;
    };
  }>('/public/health/runs', async (request, reply) => {
    try {
      const { target_id, window = '24h', page = '1', page_size = '50' } = request.query;

      if (!target_id) {
        reply.code(400).send({
          error: {
            message: '缺少参数: target_id',
            type: 'invalid_request_error',
            code: 'missing_parameter',
          },
        });
        return;
      }

      const pageNum = Math.max(1, parseInt(page));
      const pageSize = Math.min(100, Math.max(1, parseInt(page_size)));

      const allRuns = await healthAggregatorService.getTargetRuns(target_id, {
        window,
        limit: 1000, // 最多查询1000条
      });

      // 分页
      const total = allRuns.length;
      const start = (pageNum - 1) * pageSize;
      const end = start + pageSize;
      const paginatedRuns = allRuns.slice(start, end);

      reply.header('Cache-Control', 'public, max-age=30');
      return {
        runs: paginatedRuns,
        pagination: {
          page: pageNum,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  // 兼容别名前缀: /api/public/health/*
  // 这样前端可统一通过带 /api 的代理前缀访问公开健康接口
  fastify.get('/api/public/health/summary', async (request, reply) => {
    try {
      const [targets, global] = await Promise.all([
        healthAggregatorService.getAllTargetsSummary(),
        healthAggregatorService.getGlobalSummary(),
      ]);

      reply.header('Cache-Control', 'public, max-age=15');
      return {
        global,
        targets,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  fastify.get('/api/public/health/targets', async (request, reply) => {
    try {
      const targets = await healthTargetDb.getEnabled();

      const targetList = targets.map(t => ({
        id: t.id,
        name: t.name,
        type: t.type,
        check_interval_seconds: t.check_interval_seconds,
      }));

      reply.header('Cache-Control', 'public, max-age=60');
      return {
        targets: targetList,
        total: targetList.length,
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  fastify.get<{
    Querystring: { target_id?: string };
  }>('/api/public/health/detail', async (request, reply) => {
    try {
      const { target_id } = request.query;

      if (!target_id) {
        reply.code(400).send({
          error: {
            message: '缺少参数: target_id',
            type: 'invalid_request_error',
            code: 'missing_parameter',
          },
        });
        return;
      }

      const summary = await healthAggregatorService.getTargetSummary(target_id);

      reply.header('Cache-Control', 'public, max-age=15');
      return {
        ...summary,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      if (error.message.includes('不存在')) {
        reply.code(404).send({
          error: {
            message: error.message,
            type: 'not_found_error',
            code: 'target_not_found',
          },
        });
        return;
      }

      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });

  fastify.get<{
    Querystring: {
      target_id?: string;
      window?: string;
      page?: string;
      page_size?: string;
    };
  }>('/api/public/health/runs', async (request, reply) => {
    try {
      const { target_id, window = '24h', page = '1', page_size = '50' } = request.query;

      if (!target_id) {
        reply.code(400).send({
          error: {
            message: '缺少参数: target_id',
            type: 'invalid_request_error',
            code: 'missing_parameter',
          },
        });
        return;
      }

      const pageNum = Math.max(1, parseInt(page));
      const pageSize = Math.min(100, Math.max(1, parseInt(page_size)));

      const allRuns = await healthAggregatorService.getTargetRuns(target_id, {
        window,
        limit: 1000,
      });

      const total = allRuns.length;
      const start = (pageNum - 1) * pageSize;
      const end = start + pageSize;
      const paginatedRuns = allRuns.slice(start, end);

      reply.header('Cache-Control', 'public, max-age=30');
      return {
        runs: paginatedRuns,
        pagination: {
          page: pageNum,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
        timestamp: Date.now(),
      };
    } catch (error: any) {
      reply.code(500).send({
        error: {
          message: error.message || '服务器内部错误',
          type: 'internal_error',
          code: 'internal_server_error',
        },
      });
    }
  });
}
