import { FastifyInstance } from 'fastify';
import { appConfig } from '../config/index.js';
import { memoryLogger } from '../services/logger.js';
import { apiRequestDb, routingConfigDb, modelDb, systemConfigDb } from '../db/index.js';
import { generatePortkeyConfig } from '../services/config-generator.js';
import { portkeyManager } from '../services/portkey-manager.js';
import { nanoid } from 'nanoid';
import { realtimeLogger } from '../services/logger.js';


export async function configRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/system-settings', async () => {
    const allowRegCfg = systemConfigDb.get('allow_registration');
    const corsEnabledCfg = systemConfigDb.get('cors_enabled');

    return {
      allowRegistration: !(allowRegCfg && allowRegCfg.value === 'false'),
      corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === 'true' : true,
    };
  });

  fastify.post('/system-settings', async (request) => {
    const { allowRegistration, corsEnabled } = request.body as {
      allowRegistration?: boolean;
      corsEnabled?: boolean;
    };

    if (allowRegistration !== undefined) {
      await systemConfigDb.set('allow_registration', allowRegistration ? 'true' : 'false', '是否允许新用户注册');
    }

    if (corsEnabled !== undefined) {
      await systemConfigDb.set('cors_enabled', corsEnabled ? 'true' : 'false', '是否启用 CORS 跨域支持');
      memoryLogger.info(`CORS 配置已更新: ${corsEnabled ? '启用' : '禁用'}`, 'Config');
    }

    return { success: true };
  });


  fastify.get('/gateway-status', async () => {
    const endpoints = ['/v1/models', '/v1', '/'];
    let lastError: string | undefined;

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${appConfig.portkeyGatewayUrl}${endpoint}`, {
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok || response.status === 404) {
          return {
            running: true,
            status: response.status,
            url: appConfig.portkeyGatewayUrl,
            endpoint,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : '连接失败';
      }
    }

    return {
      running: false,
      status: 0,
      url: appConfig.portkeyGatewayUrl,
      error: lastError || '无法连接到 Gateway',
    };
  });

  fastify.get('/logs', async (request) => {
    const { level, limit = 100, search } = request.query as {
      level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
      limit?: number;
      search?: string;
    };

    const logs = memoryLogger.getLogs({ level, limit, search });
    const stats = memoryLogger.getStats();

    return {
      logs,
      stats,
      total: stats.total,
    };
  });

  fastify.get('/stats', async (request) => {
    const { period = '24h' } = request.query as { period?: '24h' | '7d' | '30d' };

    const now = Date.now();
    let startTime: number;

    switch (period) {
      case '7d':
        startTime = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case '30d':
        startTime = now - 30 * 24 * 60 * 60 * 1000;
        break;
      default:
        startTime = now - 24 * 60 * 60 * 1000;
    }

    const stats = apiRequestDb.getStats({ startTime, endTime: now });
    const trend = apiRequestDb.getTrend({
      startTime,
      endTime: now,
      interval: period === '24h' ? 'hour' : 'day'
    });

    return {
      period,
      stats,
      trend,
    };
  });

  fastify.get('/api-requests', async (request) => {
    const {
      page = 1,
      pageSize = 20,
      startTime,
      endTime,
      status,
      virtualKeyId,
      providerId,
      model,
    } = request.query as {
      page?: number;
      pageSize?: number;
      startTime?: number;
      endTime?: number;
      status?: string;
      virtualKeyId?: string;
      providerId?: string;
      model?: string;
    };

    const result = apiRequestDb.getAll({
      page: Number(page),
      pageSize: Number(pageSize),
      startTime: startTime ? Number(startTime) : undefined,
      endTime: endTime ? Number(endTime) : undefined,
      status,
      virtualKeyId,
      providerId,
      model,
    });

    return result;
  });

  fastify.get('/api-requests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const apiRequest = apiRequestDb.getById(id);

    if (!apiRequest) {
      throw new Error('请求记录不存在');
    }

    return apiRequest;
  });

  fastify.post('/api-requests/clean', async (request) => {
    const { daysToKeep = 30 } = request.body as { daysToKeep?: number };

    try {
      const deletedCount = await apiRequestDb.cleanOldRecords(daysToKeep);
      memoryLogger.info(`清理旧请求日志: 删除 ${deletedCount} 条记录 (保留 ${daysToKeep} 天)`, 'Config');

      return {
        success: true,
        deletedCount,
        message: `已删除 ${deletedCount} 条超过 ${daysToKeep} 天的请求日志`,
      };
    } catch (error: any) {
      memoryLogger.error(`清理请求日志失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.post('/regenerate-config', async () => {
    try {
      const configPath = await generatePortkeyConfig();
      memoryLogger.info('手动重新生成 Portkey 配置文件', 'Config');
      return {
        success: true,
        message: '配置文件已重新生成',
        path: configPath,
      };
    } catch (error: any) {
      memoryLogger.error(`重新生成配置文件失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message || '重新生成配置文件失败',
      };
    }
  });

  fastify.get('/portkey/status', async () => {
    try {
      const status = await portkeyManager.getStatus();

      return status;
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey 状态失败: ${error.message}`, 'Config');
      return {
        running: false,
        error: error.message,
      };
    }
  });

  fastify.post('/portkey/start', async () => {
    try {
      const result = await portkeyManager.start();
      if (result.success) {
        memoryLogger.info('Portkey Gateway 已启动', 'Config');
      }
      return result;
    } catch (error: any) {
      memoryLogger.error(`启动 Portkey Gateway 失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.post('/portkey/stop', async () => {
    try {
      const result = await portkeyManager.stop();
      if (result.success) {
        memoryLogger.info('Portkey Gateway 已停止', 'Config');
      }
      return result;
    } catch (error: any) {
      memoryLogger.error(`停止 Portkey Gateway 失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.post('/portkey/restart', async () => {
    try {
      const result = await portkeyManager.restart();
      if (result.success) {
        memoryLogger.info('Portkey Gateway 已重启', 'Config');
      }
      return result;
    } catch (error: any) {
      memoryLogger.error(`重启 Portkey Gateway 失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.get('/portkey/logs', async (request) => {
    try {
      const { lines = 100 } = request.query as { lines?: number };
      const result = await portkeyManager.getLogs(lines);
      return result;
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey 日志失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.post('/portkey/remove', async () => {
    try {
      const result = await portkeyManager.remove();
      if (result.success) {
        memoryLogger.info('Portkey Gateway 容器已删除', 'Config');
      }
      return result;
    } catch (error: any) {
      memoryLogger.error(`删除 Portkey Gateway 容器失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.post('/portkey/recreate', async () => {
    try {
      memoryLogger.info('重建 Portkey Gateway 容器', 'Config');

      const removeResult = await portkeyManager.remove();
      if (!removeResult.success) {
        return removeResult;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      const startResult = await portkeyManager.start();
      if (startResult.success) {
        memoryLogger.info('Portkey Gateway 容器已重建', 'Config');
      }
      return startResult;
    } catch (error: any) {
      memoryLogger.error(`重建 Portkey Gateway 容器失败: ${error.message}`, 'Config');
      return {
        success: false,
        message: error.message,
      };
    }
  });

  fastify.get('/routing-configs', async () => {
    try {
      const configs = routingConfigDb.getAll();
      return {
        configs: configs.map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          type: c.type,
          config: JSON.parse(c.config),
          enabled: c.enabled === 1,
          createdAt: c.created_at,
          updatedAt: c.updated_at,
        })),
      };
    } catch (error: any) {
      memoryLogger.error(`获取路由配置失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.post('/routing-configs', async (request) => {
    try {
      const body = request.body as {
        name: string;
        description?: string;
        type: string;
        config: any;
        createVirtualModel?: boolean;
        virtualModelName?: string;
        providerId?: string;
        modelAttributes?: any;
      };

      const configId = nanoid();
      const config = await routingConfigDb.create({
        id: configId,
        name: body.name,
        description: body.description,
        type: body.type,
        config: JSON.stringify(body.config),
      });

      memoryLogger.info(`创建路由配置: ${body.name}`, 'Config');

      let virtualModel = null;
      if (body.createVirtualModel && body.virtualModelName) {
        virtualModel = await modelDb.create({
          id: nanoid(),
          name: body.virtualModelName,
          provider_id: null,
          model_identifier: `virtual-${configId}`,
          is_virtual: 1,
          routing_config_id: configId,
          enabled: 1,
          model_attributes: body.modelAttributes ? JSON.stringify(body.modelAttributes) : null,
        });
        memoryLogger.info(`创建虚拟模型: ${body.virtualModelName}`, 'Config');
      }

      return {
        id: config!.id,
        name: config!.name,
        description: config!.description,
        type: config!.type,
        config: JSON.parse(config!.config),
        enabled: config!.enabled === 1,
        createdAt: config!.created_at,
        updatedAt: config!.updated_at,
        virtualModel: virtualModel ? {
          id: virtualModel.id,
          name: virtualModel.name,
          providerId: virtualModel.provider_id,
          modelIdentifier: virtualModel.model_identifier,
          isVirtual: true,
          routingConfigId: virtualModel.routing_config_id,
        } : null,
      };
    } catch (error: any) {
      memoryLogger.error(`创建路由配置失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.put('/routing-configs/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        description?: string;
        type?: string;
        config?: any;
        virtualModelName?: string;
        modelAttributes?: any;
      };

      const existingConfig = routingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error('路由配置不存在');
      }

      const updatedConfig = await routingConfigDb.update(id, {
        name: body.name,
        description: body.description,
        type: body.type,
        config: body.config ? JSON.stringify(body.config) : undefined,
      });

      const virtualModel = modelDb.getAll().find(m => m.routing_config_id === id && m.is_virtual === 1);
      if (virtualModel) {
        const updates: any = {};
        if (body.virtualModelName) {
          updates.name = body.virtualModelName;
        }
        if (body.modelAttributes !== undefined) {
          updates.model_attributes = body.modelAttributes ? JSON.stringify(body.modelAttributes) : null;
        }
        if (Object.keys(updates).length > 0) {
          await modelDb.update(virtualModel.id, updates);
        }
      }

      memoryLogger.info(`更新路由配置: ${id}`, 'Config');

      return {
        id: updatedConfig!.id,
        name: updatedConfig!.name,
        description: updatedConfig!.description,
        type: updatedConfig!.type,
        config: JSON.parse(updatedConfig!.config),
        enabled: updatedConfig!.enabled === 1,
        createdAt: updatedConfig!.created_at,
        updatedAt: updatedConfig!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新路由配置失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.delete('/routing-configs/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await routingConfigDb.delete(id);
      memoryLogger.info(`删除路由配置: ${id}`, 'Config');
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除路由配置失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.get('/realtime-logs', async (request, reply) => {
    memoryLogger.info(`实时日志客户端连接`, 'RealtimeLogger');
    realtimeLogger.addClient(reply);
    return reply;
  });
}

