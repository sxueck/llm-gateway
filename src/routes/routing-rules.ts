import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { modelRoutingRuleDb, portkeyGatewayDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { portkeyRouter } from '../services/portkey-router.js';

export async function routingRuleRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async () => {
    try {
      const rules = modelRoutingRuleDb.getAll();
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
      memoryLogger.error(`获取路由规则列表失败: ${error.message}`, 'RoutingRules');
      throw error;
    }
  });

  fastify.get('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const rule = modelRoutingRuleDb.getById(id);
      
      if (!rule) {
        throw new Error('路由规则不存在');
      }

      return {
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
      };
    } catch (error: any) {
      memoryLogger.error(`获取路由规则失败: ${error.message}`, 'RoutingRules');
      throw error;
    }
  });

  fastify.post('/', async (request) => {
    try {
      const body = request.body as {
        name: string;
        description?: string;
        portkeyGatewayId: string;
        ruleType: 'model_name' | 'provider' | 'region' | 'pattern';
        ruleValue: string;
        priority?: number;
        enabled?: boolean;
      };

      const gateway = portkeyGatewayDb.getById(body.portkeyGatewayId);
      if (!gateway) {
        throw new Error('指定的 Portkey Gateway 不存在');
      }

      const id = nanoid();
      const rule = await modelRoutingRuleDb.create({
        id,
        name: body.name,
        description: body.description,
        portkey_gateway_id: body.portkeyGatewayId,
        rule_type: body.ruleType,
        rule_value: body.ruleValue,
        priority: body.priority ?? 0,
        enabled: body.enabled !== false ? 1 : 0,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(
        `创建路由规则: ${body.name} (${body.ruleType}:${body.ruleValue} -> ${gateway.name})`,
        'RoutingRules'
      );

      return {
        id: rule!.id,
        name: rule!.name,
        description: rule!.description,
        portkeyGatewayId: rule!.portkey_gateway_id,
        ruleType: rule!.rule_type,
        ruleValue: rule!.rule_value,
        priority: rule!.priority,
        enabled: rule!.enabled === 1,
        createdAt: rule!.created_at,
        updatedAt: rule!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`创建路由规则失败: ${error.message}`, 'RoutingRules');
      throw error;
    }
  });

  fastify.put('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        description?: string;
        portkeyGatewayId?: string;
        ruleType?: 'model_name' | 'provider' | 'region' | 'pattern';
        ruleValue?: string;
        priority?: number;
        enabled?: boolean;
      };

      if (body.portkeyGatewayId) {
        const gateway = portkeyGatewayDb.getById(body.portkeyGatewayId);
        if (!gateway) {
          throw new Error('指定的 Portkey Gateway 不存在');
        }
      }

      const rule = await modelRoutingRuleDb.update(id, {
        name: body.name,
        description: body.description,
        portkey_gateway_id: body.portkeyGatewayId,
        rule_type: body.ruleType,
        rule_value: body.ruleValue,
        priority: body.priority,
        enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : undefined,
      });

      portkeyRouter.clearCache();

      memoryLogger.info(`更新路由规则: ${id}`, 'RoutingRules');

      return {
        id: rule!.id,
        name: rule!.name,
        description: rule!.description,
        portkeyGatewayId: rule!.portkey_gateway_id,
        ruleType: rule!.rule_type,
        ruleValue: rule!.rule_value,
        priority: rule!.priority,
        enabled: rule!.enabled === 1,
        createdAt: rule!.created_at,
        updatedAt: rule!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新路由规则失败: ${error.message}`, 'RoutingRules');
      throw error;
    }
  });

  fastify.delete('/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await modelRoutingRuleDb.delete(id);
      
      portkeyRouter.clearCache();

      memoryLogger.info(`删除路由规则: ${id}`, 'RoutingRules');
      
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除路由规则失败: ${error.message}`, 'RoutingRules');
      throw error;
    }
  });
}

