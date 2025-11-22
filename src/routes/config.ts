import { FastifyInstance } from 'fastify';
import { appConfig, setPublicUrl, validatePublicUrl } from '../config/index.js';
import { memoryLogger } from '../services/logger.js';
import { apiRequestDb, routingConfigDb, modelDb, systemConfigDb, expertRoutingLogDb, healthTargetDb, virtualKeyDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { loadAntiBotConfig, validateUserAgentList } from '../utils/anti-bot-config.js';
import { hashKey } from '../utils/crypto.js';
import { healthCheckerService } from '../services/health-checker.js';

export async function configRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/system-settings', async () => {
    const allowRegCfg = await systemConfigDb.get('allow_registration');
    const corsEnabledCfg = await systemConfigDb.get('cors_enabled');
    const publicUrlCfg = await systemConfigDb.get('public_url');
    const litellmCompatCfg = await systemConfigDb.get('litellm_compat_enabled');
    const healthMonitoringCfg = await systemConfigDb.get('health_monitoring_enabled');
    const persistentMonitoringCfg = await systemConfigDb.get('persistent_monitoring_enabled');
    const antiBot = await loadAntiBotConfig();

    return {
      allowRegistration: !(allowRegCfg && allowRegCfg.value === 'false'),
      corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === 'true' : true,
      publicUrl: publicUrlCfg ? publicUrlCfg.value : appConfig.defaultPublicUrl,
      litellmCompatEnabled: litellmCompatCfg ? litellmCompatCfg.value === 'true' : false,
      healthMonitoringEnabled: healthMonitoringCfg ? healthMonitoringCfg.value === 'true' : true,
      persistentMonitoringEnabled: persistentMonitoringCfg ? persistentMonitoringCfg.value === 'true' : false,
      antiBot,
    };
  });

  fastify.post('/system-settings', async (request) => {
    const { allowRegistration, corsEnabled, publicUrl, litellmCompatEnabled, healthMonitoringEnabled, persistentMonitoringEnabled, antiBot } = request.body as {
      allowRegistration?: boolean;
      corsEnabled?: boolean;
      publicUrl?: string;
      litellmCompatEnabled?: boolean;
      healthMonitoringEnabled?: boolean;
      persistentMonitoringEnabled?: boolean;
      antiBot?: {
        enabled?: boolean;
        blockBots?: boolean;
        blockSuspicious?: boolean;
        logOnly?: boolean;
        logHeaders?: boolean;
        allowedUserAgents?: string[];
        blockedUserAgents?: string[];
      };
    };

    try {
      if (allowRegistration !== undefined) {
        await systemConfigDb.set('allow_registration', allowRegistration ? 'true' : 'false', '是否允许新用户注册');
        const verify = await systemConfigDb.get('allow_registration');
        if (!verify || verify.value !== (allowRegistration ? 'true' : 'false')) {
          throw new Error('注册配置保存失败');
        }
      }

      if (corsEnabled !== undefined) {
        await systemConfigDb.set('cors_enabled', corsEnabled ? 'true' : 'false', '是否启用 CORS 跨域支持');
        const verify = await systemConfigDb.get('cors_enabled');
        if (!verify || verify.value !== (corsEnabled ? 'true' : 'false')) {
          throw new Error('CORS 配置保存失败');
        }
        memoryLogger.info(`CORS 配置已更新: ${corsEnabled ? '启用' : '禁用'}`, 'Config');
      }

      if (litellmCompatEnabled !== undefined) {
        await systemConfigDb.set('litellm_compat_enabled', litellmCompatEnabled ? 'true' : 'false', '是否启用 LiteLLM 兼容模式');
        const verify = await systemConfigDb.get('litellm_compat_enabled');
        if (!verify || verify.value !== (litellmCompatEnabled ? 'true' : 'false')) {
          throw new Error('LiteLLM 兼容模式配置保存失败');
        }
        memoryLogger.info(`LiteLLM 兼容模式已更新: ${litellmCompatEnabled ? '启用' : '禁用'}`, 'Config');
      }

      if (healthMonitoringEnabled !== undefined) {
        await systemConfigDb.set('health_monitoring_enabled', healthMonitoringEnabled ? 'true' : 'false', '是否启用健康监控公开页面');
        const verify = await systemConfigDb.get('health_monitoring_enabled');
        if (!verify || verify.value !== (healthMonitoringEnabled ? 'true' : 'false')) {
          throw new Error('健康监控配置保存失败');
        }
        memoryLogger.info(`健康监控公开页面已更新: ${healthMonitoringEnabled ? '启用' : '禁用'}`, 'Config');
      }

      if (persistentMonitoringEnabled !== undefined) {
        await systemConfigDb.set('persistent_monitoring_enabled', persistentMonitoringEnabled ? 'true' : 'false', '是否启用持久监控');
        const verifyPersist = await systemConfigDb.get('persistent_monitoring_enabled');
        if (!verifyPersist || verifyPersist.value !== (persistentMonitoringEnabled ? 'true' : 'false')) {
          throw new Error('持久监控配置保存失败');
        }
        memoryLogger.info(`持久监控已${persistentMonitoringEnabled ? '启用' : '禁用'}`, 'Config');

        if (persistentMonitoringEnabled) {
          // 确保存在监控专用虚拟密钥
          const keyIdCfg = await systemConfigDb.get('monitoring_virtual_key_id');
          let monitoringKey = keyIdCfg ? await virtualKeyDb.getById(keyIdCfg.value) : undefined;

          if (!monitoringKey) {
            const id = nanoid();
            const keyValue = `monitor_vk_${nanoid(24)}`;
            monitoringKey = await virtualKeyDb.create({
              id,
              key_value: keyValue,
              key_hash: hashKey(keyValue),
              name: 'System Monitoring Key',
              provider_id: null,
              model_id: null,
              routing_strategy: 'single',
              model_ids: null,
              routing_config: null,
              enabled: 1,
              rate_limit: null,
              cache_enabled: 0,
              disable_logging: 1,
              dynamic_compression_enabled: 0,
              intercept_zero_temperature: 0,
              zero_temperature_replacement: null,
            });
            await systemConfigDb.set('monitoring_virtual_key_id', monitoringKey.id, '监控专用虚拟密钥ID');
            memoryLogger.info(`已创建监控专用虚拟密钥: ${monitoringKey.id}`, 'Config');
          }

          // 将监控密钥绑定到当前全部模型，确保健康检查请求可用
          try {
            const allModels = await modelDb.getAll();
            const allModelIds = (allModels || []).map((m: any) => m.id);
            await virtualKeyDb.update(monitoringKey.id, {
              model_ids: JSON.stringify(allModelIds),
              routing_strategy: 'single',
            } as any);
            memoryLogger.info(`监控密钥已绑定 ${allModelIds.length} 个模型`, 'Config');
          } catch (bindErr: any) {
            memoryLogger.warn(`更新监控密钥模型绑定失败: ${bindErr.message}`, 'Config');
          }

          // 开启健康检查服务
          await healthCheckerService.start();
          memoryLogger.info('检测到启用持久监控，健康检查服务已启动', 'Config');
        } else {
          // 关闭健康检查服务
          await healthCheckerService.stop();
          memoryLogger.info('检测到关闭持久监控，健康检查服务已停止', 'Config');
        }
      }

      if (publicUrl !== undefined) {
        const validation = validatePublicUrl(publicUrl);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        await systemConfigDb.set('public_url', publicUrl, 'LLM Gateway 公网访问地址');
        const verify = await systemConfigDb.get('public_url');
        if (!verify || verify.value !== publicUrl) {
          throw new Error('公网地址配置保存失败');
        }
        setPublicUrl(publicUrl);
        memoryLogger.info(`LLM Gateway URL 已更新: ${publicUrl}`, 'Config');
      }

    if (antiBot !== undefined) {
      if (antiBot.allowedUserAgents !== undefined) {
        const validation = validateUserAgentList(antiBot.allowedUserAgents);
        if (!validation.valid) {
          throw new Error(`白名单验证失败: ${validation.error}`);
        }
      }
      if (antiBot.blockedUserAgents !== undefined) {
        const validation = validateUserAgentList(antiBot.blockedUserAgents);
        if (!validation.valid) {
          throw new Error(`黑名单验证失败: ${validation.error}`);
        }
      }

      if (antiBot.enabled !== undefined) {
        await systemConfigDb.set('anti_bot_enabled', antiBot.enabled ? 'true' : 'false', '是否启用反爬虫功能');
        memoryLogger.info(`反爬虫功能已更新: ${antiBot.enabled ? '启用' : '禁用'}`, 'Config');
      }
      if (antiBot.blockBots !== undefined) {
        await systemConfigDb.set('anti_bot_block_bots', antiBot.blockBots ? 'true' : 'false', '是否拦截爬虫');
      }
      if (antiBot.blockSuspicious !== undefined) {
        await systemConfigDb.set('anti_bot_block_suspicious', antiBot.blockSuspicious ? 'true' : 'false', '是否拦截可疑请求');
      }
      if (antiBot.logOnly !== undefined) {
        await systemConfigDb.set('anti_bot_log_only', antiBot.logOnly ? 'true' : 'false', '是否仅记录日志不拦截');
      }
      if (antiBot.logHeaders !== undefined) {
        await systemConfigDb.set('anti_bot_log_headers', antiBot.logHeaders ? 'true' : 'false', '是否在日志中记录完整请求头');
        memoryLogger.info(`反爬虫请求头记录已更新: ${antiBot.logHeaders ? '启用' : '禁用'}`, 'Config');
      }
      if (antiBot.allowedUserAgents !== undefined) {
        await systemConfigDb.set('anti_bot_allowed_user_agents', antiBot.allowedUserAgents.join(','), '白名单User-Agent列表');
      }
      if (antiBot.blockedUserAgents !== undefined) {
        await systemConfigDb.set('anti_bot_blocked_user_agents', antiBot.blockedUserAgents.join(','), '黑名单User-Agent列表');
      }

      const { antiBotService } = await import('../services/anti-bot.js');
      await antiBotService.reloadConfig();

      const reloadedConfig = await loadAntiBotConfig();
      if (antiBot.enabled !== undefined && reloadedConfig.enabled !== antiBot.enabled) {
        throw new Error('反爬虫配置保存验证失败');
      }
    }

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`系统配置更新失败: ${error.message}`, 'Config');
      throw error;
    }
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

    const stats = await apiRequestDb.getStats({ startTime, endTime: now });
    const trend = await apiRequestDb.getTrend({
      startTime,
      endTime: now,
      interval: period === '24h' ? 'hour' : 'day'
    });

    const expertRoutingStats = await expertRoutingLogDb.getGlobalStatistics(startTime);
    const modelStats = await apiRequestDb.getModelStats({ startTime, endTime: now });

    return {
      period,
      stats,
      trend,
      expertRoutingStats,
      modelStats,
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

    const result = await apiRequestDb.getAll({
      limit: Number(pageSize),
      offset: (Number(page) - 1) * Number(pageSize),
      startTime: startTime ? Number(startTime) : undefined,
      endTime: endTime ? Number(endTime) : undefined,
      status,
      virtualKeyId,
    });

    return result;
  });

  fastify.get('/api-requests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const apiRequest = await apiRequestDb.getById(id);

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

  fastify.get('/routing-configs', async () => {
    try {
      const configs = await routingConfigDb.getAll();
    return {
      configs: (configs as any[]).map(c => ({
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
      };

      const configId = nanoid();
      const config = await routingConfigDb.create({
        id: configId,
        name: body.name,
        description: body.description,
        type: body.type,
        config: JSON.stringify(body.config),
        enabled: 1,
      });

      memoryLogger.info(`创建路由配置: ${body.name}`, 'Config');

      let virtualModel = null;
      if (body.createVirtualModel && body.virtualModelName) {
        virtualModel = await modelDb.create({
          id: nanoid(),
          name: body.virtualModelName,
          provider_id: null,
          model_identifier: `virtual-${configId}`,
          protocol: null,
          is_virtual: 1,
          routing_config_id: configId,
          enabled: 1,
          model_attributes: null,
          prompt_config: null,
          compression_config: null,
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
      };

      const existingConfig = await routingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error('路由配置不存在');
      }

      await routingConfigDb.update(id, {
        name: body.name,
        description: body.description,
        type: body.type,
        config: body.config ? JSON.stringify(body.config) : undefined,
      });

      const allModels = await modelDb.getAll();
      const virtualModel = allModels.find((m: any) => m.routing_config_id === id && m.is_virtual === 1);
      if (virtualModel && body.virtualModelName) {
        await modelDb.update(virtualModel.id, {
          name: body.virtualModelName
        });
      }

      memoryLogger.info(`更新路由配置: ${id}`, 'Config');

      const updatedConfig = await routingConfigDb.getById(id);
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

  // 健康监控目标管理
  fastify.get('/health-targets', async () => {
    try {
      const targets = await healthTargetDb.getAll();
      return {
        targets: targets.map((t: any) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          target_id: t.target_id,
          enabled: t.enabled === 1,
          check_interval_seconds: t.check_interval_seconds,
          check_prompt: t.check_prompt,
          check_config: t.check_config ? JSON.parse(t.check_config) : null,
          created_at: t.created_at,
          updated_at: t.updated_at,
        })),
      };
    } catch (error: any) {
      memoryLogger.error(`获取健康监控目标失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.post('/health-targets', async (request) => {
    try {
      const body = request.body as {
        type: 'model' | 'virtual_model';
        target_id: string;
        check_interval_seconds?: number;
        check_prompt?: string;
      };

      // 获取目标名称
      let targetName = '';
      if (body.type === 'model') {
        const model = await modelDb.getById(body.target_id);
        if (!model) {
          throw new Error('模型不存在');
        }
        targetName = model.name;
      } else {
        const model = await modelDb.getById(body.target_id);
        if (!model || model.is_virtual !== 1) {
          throw new Error('虚拟模型不存在');
        }
        targetName = model.name;
      }

      const targetId = nanoid();
      const target = await healthTargetDb.create({
        id: targetId,
        name: targetName,
        type: body.type,
        target_id: body.target_id,
        enabled: 1,
        check_interval_seconds: body.check_interval_seconds ?? 300,
        check_prompt: body.check_prompt || "Say 'OK'",
        check_config: null,
      });

      memoryLogger.info(`创建健康监控目标: ${targetName} (${body.type})`, 'Config');

      return {
        id: target.id,
        name: target.name,
        type: target.type,
        target_id: target.target_id,
        enabled: target.enabled === 1,
        check_interval_seconds: target.check_interval_seconds,
        check_prompt: target.check_prompt,
        created_at: target.created_at,
        updated_at: target.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`创建健康监控目标失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.put('/health-targets/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        enabled?: boolean;
        check_interval_seconds?: number;
        check_prompt?: string;
      };

      const existingTarget = await healthTargetDb.getById(id);
      if (!existingTarget) {
        throw new Error('监控目标不存在');
      }

      const updates: any = {};
      if (body.enabled !== undefined) {
        updates.enabled = body.enabled ? 1 : 0;
      }
      if (body.check_interval_seconds !== undefined) {
        updates.check_interval_seconds = body.check_interval_seconds;
      }
      if (body.check_prompt !== undefined) {
        updates.check_prompt = body.check_prompt;
      }
      await healthTargetDb.update(id, updates);

      memoryLogger.info(`更新健康监控目标: ${id}`, 'Config');

      const updatedTarget = await healthTargetDb.getById(id);
      return {
        id: updatedTarget!.id,
        name: updatedTarget!.name,
        type: updatedTarget!.type,
        target_id: updatedTarget!.target_id,
        enabled: updatedTarget!.enabled === 1,
        check_interval_seconds: updatedTarget!.check_interval_seconds,
        check_prompt: updatedTarget!.check_prompt,
        created_at: updatedTarget!.created_at,
        updated_at: updatedTarget!.updated_at,
      };
    } catch (error: any) {
      memoryLogger.error(`更新健康监控目标失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.delete('/health-targets/:id', async (request) => {
    try {
      const { id } = request.params as { id: string };
      await healthTargetDb.delete(id);
      memoryLogger.info(`删除健康监控目标: ${id}`, 'Config');
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除健康监控目标失败: ${error.message}`, 'Config');
      throw error;
    }
  });

}

