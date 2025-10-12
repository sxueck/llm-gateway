import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { portkeyGatewayDb, modelRoutingRuleDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { portkeyRouter } from '../services/portkey-router.js';
import { PortkeyManager } from '../services/portkey-manager.js';

export async function portkeyGatewayRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    try {
      const gateways = portkeyGatewayDb.getAll();
      return gateways.map(gateway => ({
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        description: gateway.description,
        isDefault: gateway.is_default === 1,
        enabled: gateway.enabled === 1,
        containerName: gateway.container_name,
        port: gateway.port,
        createdAt: gateway.created_at,
        updatedAt: gateway.updated_at,
      }));
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey Gateway 列表失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.get('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const gateway = portkeyGatewayDb.getById(id);

      if (!gateway) {
        throw new Error('Portkey Gateway 不存在');
      }

      return {
        id: gateway.id,
        name: gateway.name,
        url: gateway.url,
        description: gateway.description,
        isDefault: gateway.is_default === 1,
        enabled: gateway.enabled === 1,
        containerName: gateway.container_name,
        port: gateway.port,
        createdAt: gateway.created_at,
        updatedAt: gateway.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.get('/:id/health', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const gateway = portkeyGatewayDb.getById(id);

      if (!gateway) {
        return { success: false, latency: null, error: 'Gateway 不存在' };
      }

      const startTime = Date.now();

      try {
        const response = await fetch(`${gateway.url}/health`, {
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok || response.status === 404) {
          const latency = Date.now() - startTime;
          return { success: true, latency };
        } else {
          return { success: false, latency: null, error: `HTTP ${response.status}` };
        }
      } catch (error: any) {
        return { success: false, latency: null, error: error.message };
      }
    } catch (error: any) {
      memoryLogger.error(`检测 Gateway 健康状态失败: ${error.message}`, 'PortkeyGateways');
      return { success: false, latency: null, error: error.message };
    }
  });

  fastify.post('/', async (request) => {
    try {
      const body = request.body as {
        name: string;
        url: string;
        description?: string;
        isDefault?: boolean;
        enabled?: boolean;
        containerName?: string;
        port?: number;
      };

      const id = nanoid();
      const gateway = await portkeyGatewayDb.create({
        id,
        name: body.name,
        url: body.url,
        description: body.description,
        is_default: body.isDefault ? 1 : 0,
        enabled: body.enabled !== false ? 1 : 0,
        container_name: body.containerName,
        port: body.port,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(`创建 Portkey Gateway: ${body.name} (${body.url})`, 'PortkeyGateways');

      return {
        id: gateway!.id,
        name: gateway!.name,
        url: gateway!.url,
        description: gateway!.description,
        isDefault: gateway!.is_default === 1,
        enabled: gateway!.enabled === 1,
        containerName: gateway!.container_name,
        port: gateway!.port,
        createdAt: gateway!.created_at,
        updatedAt: gateway!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`创建 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.put('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        url?: string;
        description?: string;
        isDefault?: boolean;
        enabled?: boolean;
        containerName?: string;
        port?: number;
      };

      const gateway = await portkeyGatewayDb.update(id, {
        name: body.name,
        url: body.url,
        description: body.description,
        is_default: body.isDefault !== undefined ? (body.isDefault ? 1 : 0) : undefined,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
        container_name: body.containerName,
        port: body.port,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(`更新 Portkey Gateway: ${id}`, 'PortkeyGateways');

      return {
        id: gateway!.id,
        name: gateway!.name,
        url: gateway!.url,
        description: gateway!.description,
        isDefault: gateway!.is_default === 1,
        enabled: gateway!.enabled === 1,
        containerName: gateway!.container_name,
        port: gateway!.port,
        createdAt: gateway!.created_at,
        updatedAt: gateway!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.delete('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await portkeyGatewayDb.delete(id);
      
      portkeyRouter.clearCache();

      memoryLogger.info(`删除 Portkey Gateway: ${id}`, 'PortkeyGateways');
      
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除 Portkey Gateway 失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });

  fastify.post('/install-agent', async (request) => {
    try {
      const body = request.body as {
        name: string;
        port?: number;
        description?: string;
        isDefault?: boolean;
      };

      const port = body.port || 8787;
      const containerName = `portkey-gateway-${nanoid(6)}`;

      const portkeyManager = new PortkeyManager({
        containerName,
        port,
      });

      const startResult = await portkeyManager.start();

      if (!startResult.success) {
        throw new Error(startResult.message);
      }

      const id = nanoid();
      const gateway = await portkeyGatewayDb.create({
        id,
        name: body.name,
        url: `http://localhost:${port}`,
        description: body.description,
        is_default: body.isDefault ? 1 : 0,
        enabled: 1,
        container_name: containerName,
        port,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(
        `Agent 安装成功: ${body.name} (容器: ${containerName}, 端口: ${port})`,
        'PortkeyGateways'
      );

      return {
        success: true,
        message: 'Portkey Gateway Agent 安装成功',
        gateway: {
          id: gateway!.id,
          name: gateway!.name,
          url: gateway!.url,
          description: gateway!.description,
          isDefault: gateway!.is_default === 1,
          enabled: gateway!.enabled === 1,
          containerName: gateway!.container_name,
          port: gateway!.port,
          createdAt: gateway!.created_at,
          updatedAt: gateway!.updated_at,
        },
        containerId: startResult.containerId,
      };
    } catch (error: any) {
      memoryLogger.error(`安装 Agent 失败: ${error.message}`, 'PortkeyGateways');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.get('/:id/routing-rules', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const rules = modelRoutingRuleDb.getByGatewayId(id);
      
      return rules.map(rule => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        portkeyGatewayId: rule.portkey_gateway_id,
        ruleType: rule.rule_type,
        ruleValue: rule.rule_value,
        priority: rule.priority,
        enabled: rule.enabled === 1,
        createdAt: rule.created_at,
        updatedAt: rule.updated_at,
      }));
    } catch (error: any) {
      memoryLogger.error(`获取路由规则失败: ${error.message}`, 'PortkeyGateways');
      throw error;
    }
  });
}

