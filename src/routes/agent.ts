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
  fastify.post('/report-status', { preHandler: authenticateAgent }, async (request, reply) => {
    try {
      const gateway = (request as any).gateway;

      const body = request.body as {
        status: string;
        port?: number;
      };

      await portkeyGatewayDb.update(gateway.id, {
        install_status: body.status,
        enabled: body.status === 'installed' ? 1 : 0,
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
}

