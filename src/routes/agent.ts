import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { portkeyGatewayDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { portkeyRouter } from '../services/portkey-router.js';

async function authenticateAgent(request: FastifyRequest, reply: FastifyReply) {
  const gatewayId = request.headers['x-gateway-id'] as string;
  const apiKey = request.headers['x-api-key'] as string;

  if (!gatewayId || !apiKey) {
    return reply.code(401).send({
      success: false,
      message: '缺少认证信息',
    });
  }

  const gateway = portkeyGatewayDb.getById(gatewayId);

  if (!gateway) {
    return reply.code(404).send({
      success: false,
      message: '网关不存在',
    });
  }

  if (gateway.api_key !== apiKey) {
    return reply.code(401).send({
      success: false,
      message: 'API Key 无效',
    });
  }

  (request as any).gateway = gateway;
}

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.post('/register', { preHandler: authenticateAgent }, async (request, reply) => {
    try {
      const gateway = (request as any).gateway;
      const body = (request.body || {}) as {
        version?: string;
        hostname?: string;
      };

      await portkeyGatewayDb.update(gateway.id, {
        install_status: 'online',
        enabled: 1,
        last_heartbeat: Date.now(),
        agent_version: body.version,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(
        `Agent 注册成功: ${gateway.name} (${gateway.id}) - 版本: ${body.version || 'unknown'}`,
        'Agent'
      );

      return {
        success: true,
        message: '注册成功',
        config: {
          heartbeatInterval: 30000,
          configSyncInterval: 300000,
        },
      };
    } catch (error: any) {
      memoryLogger.error(`Agent 注册失败: ${error.message}`, 'Agent');
      return reply.code(500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/heartbeat', { preHandler: authenticateAgent }, async (request, reply) => {
    try {
      const gateway = (request as any).gateway;

      await portkeyGatewayDb.update(gateway.id, {
        last_heartbeat: Date.now(),
      });

      return {
        success: true,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      memoryLogger.error(`Agent 心跳失败: ${error.message}`, 'Agent');
      return reply.code(500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.post('/report-status', { preHandler: authenticateAgent }, async (request, reply) => {
    try {
      const gateway = (request as any).gateway;

      const body = (request.body || {}) as {
        status: string;
        port?: number;
      };

      await portkeyGatewayDb.update(gateway.id, {
        install_status: body.status,
        enabled: body.status === 'installed' || body.status === 'online' ? 1 : 0,
        last_heartbeat: Date.now(),
      });

      portkeyRouter.clearCache();

      memoryLogger.info(
        `Agent 状态更新: ${gateway.name} (${gateway.id}) - ${body.status}`,
        'Agent'
      );

      return {
        success: true,
        message: '状态更新成功',
      };
    } catch (error: any) {
      memoryLogger.error(`Agent 状态报告失败: ${error.message}`, 'Agent');
      return reply.code(500).send({
        success: false,
        message: error.message,
      });
    }
  });

  fastify.get('/health', { preHandler: authenticateAgent }, async (request, reply) => {
    try {
      const gateway = (request as any).gateway;

      return {
        success: true,
        gateway: {
          id: gateway.id,
          name: gateway.name,
          enabled: gateway.enabled === 1,
          installStatus: gateway.install_status,
        },
      };
    } catch (error: any) {
      memoryLogger.error(`Agent 健康检查失败: ${error.message}`, 'Agent');
      return reply.code(500).send({
        success: false,
        message: error.message,
      });
    }
  });

  async function getPortkeyConfig(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { readFile } = await import('fs/promises');
      const { appConfig } = await import('../config/index.js');

      const configContent = await readFile(appConfig.portkeyConfigPath, 'utf-8');
      const config = JSON.parse(configContent);

      memoryLogger.info(
        `Agent 配置拉取: ${(request as any).gateway.name}`,
        'Agent'
      );

      return reply
        .header('Content-Type', 'application/json')
        .send(config);
    } catch (error: any) {
      memoryLogger.error(`Agent 配置拉取失败: ${error.message}`, 'Agent');
      return reply.code(500).send({
        success: false,
        message: error.message,
      });
    }
  }

  fastify.get('/portkey-config', { preHandler: authenticateAgent }, getPortkeyConfig);
  fastify.get('/config', { preHandler: authenticateAgent }, getPortkeyConfig);

  fastify.get('/version', async (_request, reply) => {
    const AGENT_VERSION = '1.0.0';
    return reply.send(AGENT_VERSION);
  });
}

