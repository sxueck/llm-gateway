import { FastifyInstance } from 'fastify';
import { appConfig, setPublicUrl, validatePublicUrl } from '../config/index.js';
import { memoryLogger } from '../services/logger.js';
import { apiRequestDb, routingConfigDb, modelDb, systemConfigDb, expertRoutingLogDb, healthTargetDb, virtualKeyDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { loadAntiBotConfig, validateUserAgentList } from '../utils/anti-bot-config.js';
import { DEFAULT_AIFW_MASK_CONFIG, loadAifwConfig } from '../utils/aifw-config.js';
import { hashKey } from '../utils/crypto.js';
import { healthCheckerService } from '../services/health-checker.js';
import { debugModeService } from '../services/debug-mode.js';
import { circuitBreaker } from '../services/circuit-breaker.js';
import { costMappingService } from '../services/cost-mapping.js';
import { threatIpBlocker } from '../services/threat-ip-blocker.js';
import { manualIpBlocklist } from '../services/manual-ip-blocklist.js';
import { getGeoInfo, normalizeIp } from '../utils/ip.js';

export async function configRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  async function ensureMonitoringVirtualKey() {
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

    return monitoringKey;
  }

  async function syncMonitoringKeyModelsFromTargets() {
    const persistentCfg = await systemConfigDb.get('persistent_monitoring_enabled');
    if (!persistentCfg || persistentCfg.value !== 'true') {
      return;
    }

    const monitoringKey = await ensureMonitoringVirtualKey();
    const targets = await healthTargetDb.getAll();
    const enabledTargets = targets.filter((t: any) => t.enabled === 1);
    const modelIds = Array.from(new Set(enabledTargets.map((t: any) => t.target_id))).filter(Boolean);

    await virtualKeyDb.update(monitoringKey.id, {
      model_ids: JSON.stringify(modelIds),
      routing_strategy: 'single',
    } as any);
    memoryLogger.info(`监控密钥已同步 ${modelIds.length} 个监控目标`, 'Config');
  }

  fastify.get('/system-settings', async () => {
    const allowRegCfg = await systemConfigDb.get('allow_registration');
    const corsEnabledCfg = await systemConfigDb.get('cors_enabled');
    const publicUrlCfg = await systemConfigDb.get('public_url');
    const litellmCompatCfg = await systemConfigDb.get('litellm_compat_enabled');
    const healthMonitoringCfg = await systemConfigDb.get('health_monitoring_enabled');
    const persistentMonitoringCfg = await systemConfigDb.get('persistent_monitoring_enabled');
    const debugEnabledCfg = await systemConfigDb.get('developer_debug_enabled');
    const debugExpiresCfg = await systemConfigDb.get('developer_debug_expires_at');
    const dashboardHideRequestSourceCardCfg = await systemConfigDb.get('dashboard_hide_request_source_card');
    const antiBot = await loadAntiBotConfig();
    const aifw = await loadAifwConfig();

    const now = Date.now();
    const rawExpiresAt = debugExpiresCfg ? Number(debugExpiresCfg.value) : 0;
    const activeDebug = debugEnabledCfg?.value === 'true' && rawExpiresAt > now;

    return {
      allowRegistration: !(allowRegCfg && allowRegCfg.value === 'false'),
      corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === 'true' : true,
      publicUrl: publicUrlCfg ? publicUrlCfg.value : appConfig.defaultPublicUrl,
      litellmCompatEnabled: litellmCompatCfg ? litellmCompatCfg.value === 'true' : false,
      healthMonitoringEnabled: healthMonitoringCfg ? healthMonitoringCfg.value === 'true' : true,
      persistentMonitoringEnabled: persistentMonitoringCfg ? persistentMonitoringCfg.value === 'true' : false,
      developerDebugEnabled: activeDebug,
      developerDebugExpiresAt: activeDebug ? rawExpiresAt : null,
      dashboardHideRequestSourceCard: dashboardHideRequestSourceCardCfg ? dashboardHideRequestSourceCardCfg.value === 'true' : false,
      antiBot,
      aifw: {
        enabled: aifw.enabled,
        baseUrl: aifw.baseUrl,
        failOpen: aifw.failOpen,
        timeoutMs: aifw.timeoutMs,
        // Provide UI-friendly defaults even when config is empty.
        maskConfig: aifw.maskConfig || DEFAULT_AIFW_MASK_CONFIG,
        httpApiKeySet: !!aifw.httpApiKey,
      },
    };
  });

  fastify.get('/request-sources/lookup', async (request, reply) => {
    const { ip } = request.query as { ip?: string };
    if (!ip) {
      return reply.code(400).send({
        error: {
          message: 'IP 地址不能为空',
          type: 'invalid_request_error',
          param: 'ip',
          code: 'invalid_ip',
        }
      });
    }

    const normalizedIp = normalizeIp(ip);
    if (!normalizedIp) {
      return reply.code(400).send({
        error: {
          message: '无效的 IP 地址',
          type: 'invalid_request_error',
          param: 'ip',
          code: 'invalid_ip_format',
        }
      });
    }

    const [geo, lastRequestByIp, blockedInfo] = await Promise.all([
      getGeoInfo(normalizedIp),
      apiRequestDb.getLastRequestByIp(normalizedIp),
      manualIpBlocklist.isBlocked(normalizedIp),
    ]);

    return {
      ip: normalizedIp,
      geo,
      blocked: !!blockedInfo,
      blockedReason: blockedInfo?.reason || null,
      lastSeen: lastRequestByIp?.created_at || null,
      userAgent: lastRequestByIp?.user_agent || null,
    };
  });

  fastify.post('/request-sources/block', async (request, reply) => {
    const { ip, reason } = request.body as { ip?: string; reason?: string };
    if (!ip) {
      return reply.code(400).send({
        error: {
          message: 'IP 地址不能为空',
          type: 'invalid_request_error',
          param: 'ip',
          code: 'invalid_ip',
        }
      });
    }

    try {
      const entry = await manualIpBlocklist.block(ip, reason);
      return {
        success: true,
        blocked: {
          ip: entry.ip,
          reason: entry.reason,
          timestamp: entry.createdAt,
        }
      };
    } catch (error: any) {
      memoryLogger.error(`手动拦截 IP 失败: ${error?.message || error}`, 'ManualBlock');
      return reply.code(400).send({
        error: {
          message: error?.message || '拦截 IP 失败',
          type: 'invalid_request_error',
          param: 'ip',
          code: 'block_ip_failed',
        }
      });
    }
  });

  fastify.post('/system-settings/refresh-threat-ip', async () => {
    try {
      await threatIpBlocker.refresh();
      return { success: true, message: '威胁 IP 列表已刷新' };
    } catch (error: any) {
      memoryLogger.error(`手动刷新威胁 IP 列表失败: ${error.message}`, 'Config');
      throw error;
    }
  });

  fastify.post('/system-settings', async (request) => {
    const { allowRegistration, corsEnabled, publicUrl, litellmCompatEnabled, healthMonitoringEnabled, persistentMonitoringEnabled, developerDebugEnabled, dashboardHideRequestSourceCard, antiBot, aifw } = request.body as {
      allowRegistration?: boolean;
      corsEnabled?: boolean;
      publicUrl?: string;
      litellmCompatEnabled?: boolean;
      healthMonitoringEnabled?: boolean;
      persistentMonitoringEnabled?: boolean;
      developerDebugEnabled?: boolean;
      dashboardHideRequestSourceCard?: boolean;
      antiBot?: {
        enabled?: boolean;
        blockBots?: boolean;
        blockSuspicious?: boolean;
        blockThreatIPs?: boolean;
        logOnly?: boolean;
        logHeaders?: boolean;
        allowedUserAgents?: string[];
        blockedUserAgents?: string[];
      };
      aifw?: {
        enabled?: boolean;
        baseUrl?: string;
        httpApiKey?: string;
        failOpen?: boolean;
        timeoutMs?: number;
        maskConfigJson?: string;
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
          await ensureMonitoringVirtualKey();
          try {
            await syncMonitoringKeyModelsFromTargets();
          } catch (syncErr: any) {
            memoryLogger.warn(`同步监控密钥模型失败: ${syncErr.message}`, 'Config');
          }

          await healthCheckerService.start();
          memoryLogger.info('检测到启用持久监控，健康检查服务已启动', 'Config');
        } else {
          await healthCheckerService.stop();
          memoryLogger.info('检测到关闭持久监控，健康检查服务已停止', 'Config');

          const keyIdCfg = await systemConfigDb.get('monitoring_virtual_key_id');
          if (keyIdCfg) {
            try {
              await virtualKeyDb.update(keyIdCfg.value, {
                model_ids: JSON.stringify([]),
              } as any);
              memoryLogger.info('已清空监控虚拟密钥的模型绑定', 'Config');
            } catch (clearErr: any) {
              memoryLogger.warn(`清空监控密钥模型绑定失败: ${clearErr.message}`, 'Config');
            }
          }
        }
      }

      // Developer debug mode: 15 minutes temporary window
      if (developerDebugEnabled !== undefined) {
        if (developerDebugEnabled) {
          const expiresAt = Date.now() + 15 * 60 * 1000;
          await systemConfigDb.set('developer_debug_enabled', 'true', '是否启用开发者调试模式');
          await systemConfigDb.set('developer_debug_expires_at', String(expiresAt), '开发者调试模式到期时间');
          debugModeService.setState(true, expiresAt);
          memoryLogger.warn(`开发者调试模式已开启，将在 ${new Date(expiresAt).toLocaleString('zh-CN')} 自动关闭`, 'Config');
        } else {
          await systemConfigDb.set('developer_debug_enabled', 'false', '是否启用开发者调试模式');
          await systemConfigDb.set('developer_debug_expires_at', '0', '开发者调试模式到期时间');
          debugModeService.setState(false, Date.now());
          memoryLogger.info('开发者调试模式已关闭', 'Config');
        }
      }

      if (dashboardHideRequestSourceCard !== undefined) {
        await systemConfigDb.set(
          'dashboard_hide_request_source_card',
          dashboardHideRequestSourceCard ? 'true' : 'false',
          '是否在首页隐藏「请求来源」'
        );
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
      if (antiBot.blockThreatIPs !== undefined) {
        await systemConfigDb.set('anti_bot_block_threat_ips', antiBot.blockThreatIPs ? 'true' : 'false', '是否拦截威胁IP');
        memoryLogger.info(`威胁 IP 拦截已更新: ${antiBot.blockThreatIPs ? '启用' : '禁用'}`, 'Config');
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

      if (aifw !== undefined) {
        if (aifw.enabled !== undefined) {
          await systemConfigDb.set('aifw_enabled', aifw.enabled ? 'true' : 'false', '是否启用 OneAIFW 预处理');
          memoryLogger.info(`OneAIFW 预处理已更新: ${aifw.enabled ? '启用' : '禁用'}`, 'Config');
        }

        if (aifw.baseUrl !== undefined) {
          const trimmed = String(aifw.baseUrl || '').trim();
          try {
            const url = new URL(trimmed);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
              throw new Error('unsupported protocol');
            }
          } catch {
            throw new Error('OneAIFW Base URL 无效，请使用 http(s)://...');
          }
          await systemConfigDb.set('aifw_base_url', trimmed.replace(/\/+$/, ''), 'OneAIFW 服务地址');
        }

        if (aifw.httpApiKey !== undefined) {
          const key = String(aifw.httpApiKey || '').trim();
          await systemConfigDb.set('aifw_http_api_key', key, 'OneAIFW HTTP API Key（可选）');
        }

        if (aifw.failOpen !== undefined) {
          await systemConfigDb.set('aifw_fail_open', aifw.failOpen ? 'true' : 'false', 'OneAIFW 失败时是否放行（fail-open）');
        }

        if (aifw.timeoutMs !== undefined) {
          const n = Number(aifw.timeoutMs);
          if (!Number.isFinite(n) || n < 500 || n > 60000) {
            throw new Error('OneAIFW 超时应在 500~60000ms 之间');
          }
          await systemConfigDb.set('aifw_timeout_ms', String(Math.floor(n)), 'OneAIFW 请求超时（ms）');
        }

        if (aifw.maskConfigJson !== undefined) {
          const raw = String(aifw.maskConfigJson || '').trim();
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('maskConfigJson must be an object');
              }

              const allowedKeys = new Set<string>([
                ...Object.keys(DEFAULT_AIFW_MASK_CONFIG),
                'maskAll',
              ]);
              for (const [key, value] of Object.entries(parsed)) {
                if (!allowedKeys.has(key)) {
                  throw new Error(`unknown key: ${key}`);
                }
                if (typeof value !== 'boolean') {
                  throw new Error(`invalid value type for ${key}`);
                }
              }
            } catch (error: any) {
              const detail = error?.message ? `: ${error.message}` : '';
              throw new Error(`OneAIFW maskConfigJson 校验失败${detail}`);
            }
          }
          await systemConfigDb.set('aifw_mask_config_json', raw, 'OneAIFW maskConfig 配置（JSON）');
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

  // 计算成本的辅助函数
  async function calculateCostStats(startTime: number, endTime: number) {
    const pool = await import('../db/connection.js').then(m => m.getDatabase());
    const conn = await pool.getConnection();
    try {
      // 获取所有请求的模型和 token 使用情况
      const [rows] = await conn.query(
        `SELECT
          ar.model,
          SUM(ar.prompt_tokens) as total_prompt_tokens,
          SUM(ar.completion_tokens) as total_completion_tokens,
          SUM(ar.cached_tokens) as total_cached_tokens
        FROM api_requests ar
        LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
        WHERE ar.created_at >= ? AND ar.created_at <= ?
          AND ar.status = 'success'
          AND (ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)
        GROUP BY ar.model`,
        [startTime, endTime]
      );

      const modelUsage = rows as any[];
      let totalCost = 0;
      const modelCosts: any[] = [];

      for (const usage of modelUsage) {
        if (!usage.model) continue;

        // 尝试解析模型成本
        const costInfo = await costMappingService.resolveModelCost(usage.model);
        
        if (costInfo && costInfo.info) {
          const info = costInfo.info;
          let modelCost = 0;

          // 计算输入成本
          if (info.input_cost_per_token && usage.total_prompt_tokens) {
            modelCost += Number(usage.total_prompt_tokens) * Number(info.input_cost_per_token);
          }

          // 计算输出成本
          if (info.output_cost_per_token && usage.total_completion_tokens) {
            modelCost += Number(usage.total_completion_tokens) * Number(info.output_cost_per_token);
          }

          // 缓存 tokens 通常成本更低（如果有专门的缓存成本）
          // 这里假设缓存成本为输入成本的 10%
          if (info.input_cost_per_token && usage.total_cached_tokens) {
            modelCost += Number(usage.total_cached_tokens) * Number(info.input_cost_per_token) * 0.1;
          }

          totalCost += modelCost;
          
          if (modelCost > 0) {
            modelCosts.push({
              model: usage.model,
              cost: modelCost,
              promptTokens: Number(usage.total_prompt_tokens || 0),
              completionTokens: Number(usage.total_completion_tokens || 0),
              cachedTokens: Number(usage.total_cached_tokens || 0),
            });
          }
        }
      }

      // 按成本排序
      modelCosts.sort((a, b) => b.cost - a.cost);

      return {
        totalCost,
        modelCosts: modelCosts.slice(0, 10), // 返回前 10 个最贵的模型
      };
    } finally {
      conn.release();
    }
  }

  fastify.get('/stats', async (request) => {
    const { period = '24h' } = request.query as { period?: '24h' | '7d' | '30d' | 'all' };

    const now = Date.now();
    let startTime: number;

    switch (period) {
      case '7d':
        startTime = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case '30d':
        startTime = now - 30 * 24 * 60 * 60 * 1000;
        break;
      case 'all':
        startTime = 0;
        break;
      default:
        startTime = now - 24 * 60 * 60 * 1000;
    }

    const stats = await apiRequestDb.getStats({ startTime, endTime: now });
    const dbSize = await apiRequestDb.getDbSize();
    const dbUptime = await apiRequestDb.getDbUptime();
    const trend = await apiRequestDb.getTrend({
      startTime,
      endTime: now,
      interval: period === '24h' ? 'hour' : 'day'
    });
 
    const expertRoutingStats = await expertRoutingLogDb.getGlobalStatistics(startTime);
    const modelStats = await apiRequestDb.getModelStats({ startTime, endTime: now });
    const modelResponseTimeStats = await apiRequestDb.getModelResponseTimeStats({ startTime, endTime: now });
    // 熔断器统计改为从数据库获取持久化结果，并传递时间范围参数
    const circuitBreakerStats = await import('../db/repositories/circuit-breaker-stats.repository.js').then(m => m.circuitBreakerStatsRepository.getGlobalStats(startTime));

    const lastRequest = await apiRequestDb.getLastRequest();
    const manualLastBlocked = manualIpBlocklist.getLastBlocked();
    const threatIpStats = threatIpBlocker.getStats();
    const threatLastBlocked = threatIpStats.lastBlockedIp
      ? { ip: threatIpStats.lastBlockedIp, timestamp: threatIpStats.lastBlockedAt || 0, reason: null, source: 'threat' as const }
      : null;
    const lastBlockedInfo = manualLastBlocked
      ? { ip: manualLastBlocked.ip, timestamp: manualLastBlocked.createdAt, reason: manualLastBlocked.reason, source: 'manual' as const }
      : threatLastBlocked;

    const [lastRequestGeo, lastBlockedGeo] = await Promise.all([
      getGeoInfo(lastRequest?.ip),
      getGeoInfo(lastBlockedInfo?.ip),
    ]);

    const recentIps = await apiRequestDb.getRecentUniqueIps(50);
    const sourceCandidates: Array<{
      ip: string;
      timestamp: number;
      count: number;
      type: 'normal' | 'blocked';
    }> = recentIps
      .filter((row: any) => !!row.ip)
      .map((row: any) => ({
        ip: row.ip,
        timestamp: row.last_seen,
        count: row.count,
        type: 'normal' as const,
      }));

    if (lastBlockedInfo?.ip) {
      sourceCandidates.unshift({
        ip: lastBlockedInfo.ip,
        timestamp: lastBlockedInfo.timestamp || Date.now(),
        count: 0,
        type: 'blocked',
      });
    }

    sourceCandidates.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const dedupedSources: typeof sourceCandidates = [];
    const seenIps = new Set<string>();
    for (const candidate of sourceCandidates) {
      if (!candidate.ip || seenIps.has(candidate.ip)) continue;
      dedupedSources.push(candidate);
      seenIps.add(candidate.ip);
      if (dedupedSources.length >= 10) break;
    }

    const recentSources = await Promise.all(
      dedupedSources.map(async (entry) => {
        const [geo, lastRequestForIp, manualBlocked] = await Promise.all([
          getGeoInfo(entry.ip),
          apiRequestDb.getLastRequestByIp(entry.ip),
          manualIpBlocklist.isBlocked(entry.ip),
        ]);
        return {
          ip: entry.ip,
          timestamp: lastRequestForIp?.created_at || entry.timestamp,
          count: entry.count,
          type: manualBlocked ? 'blocked' : entry.type,
          geo,
          userAgent: lastRequestForIp?.user_agent || null,
          blockedReason: manualBlocked?.reason || null,
        };
      })
    );

    const requestSourceStats = {
      lastRequest: lastRequest
        ? {
            ip: lastRequest.ip,
            geo: lastRequestGeo,
            timestamp: lastRequest?.created_at || 0,
            userAgent: lastRequest?.user_agent || null,
          }
        : null,
      lastBlocked: lastBlockedInfo?.ip
        ? {
            ip: lastBlockedInfo.ip,
            geo: lastBlockedGeo,
            timestamp: lastBlockedInfo?.timestamp || 0,
            reason: lastBlockedInfo.reason || null,
            source: lastBlockedInfo.source,
          }
        : null,
      recentSources,
    };

    // 计算成本统计
    let costStats = null;
    try {
      costStats = await calculateCostStats(startTime, now);
    } catch (error: any) {
      memoryLogger.warn(`计算成本统计失败: ${error.message}`, 'Config');
    }

    return {
      period,
      stats: { ...stats, dbSize, dbUptime },
      trend,
      expertRoutingStats,
      modelStats,
      modelResponseTimeStats,
      circuitBreakerStats,
      costStats,
      requestSourceStats,
      threatIpStats,
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

      const existingConfig = await routingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error('路由配置不存在');
      }

      const associatedModels = await modelDb.getByRoutingConfigId(id);
      let deletedModels = 0;
      let detachedModels = 0;

      for (const model of associatedModels) {
        if (model.is_virtual === 1) {
          await modelDb.delete(model.id);
          deletedModels++;
        } else {
          await modelDb.update(model.id, { routing_config_id: null });
          detachedModels++;
        }
      }

      await routingConfigDb.delete(id);
      memoryLogger.info(
        `删除路由配置: ${id} | 删除虚拟模型: ${deletedModels} 个 | 解绑模型: ${detachedModels} 个`,
        'Config'
      );
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
          display_title: t.display_title,
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
        display_title: null,
        type: body.type,
        target_id: body.target_id,
        enabled: 1,
        check_interval_seconds: body.check_interval_seconds ?? 300,
        check_prompt: body.check_prompt || "Say 'OK'",
        check_config: null,
      });

      memoryLogger.info(`创建健康监控目标: ${targetName} (${body.type})`, 'Config');

      try {
        await syncMonitoringKeyModelsFromTargets();
      } catch (syncErr: any) {
        memoryLogger.warn(`新增监控目标后同步监控密钥失败: ${syncErr.message}`, 'Config');
      }

      return {
        id: target.id,
        name: target.name,
        display_title: target.display_title,
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
        display_title?: string | null;
        enabled?: boolean;
        check_interval_seconds?: number;
        check_prompt?: string;
      };

      const existingTarget = await healthTargetDb.getById(id);
      if (!existingTarget) {
        throw new Error('监控目标不存在');
      }

      const updates: any = {};
      if (body.display_title !== undefined) {
        updates.display_title = body.display_title || null;
      }
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

      try {
        await syncMonitoringKeyModelsFromTargets();
      } catch (syncErr: any) {
        memoryLogger.warn(`更新监控目标后同步监控密钥失败: ${syncErr.message}`, 'Config');
      }

      const updatedTarget = await healthTargetDb.getById(id);
      return {
        id: updatedTarget!.id,
        name: updatedTarget!.name,
        display_title: updatedTarget!.display_title,
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

      try {
        await syncMonitoringKeyModelsFromTargets();
      } catch (syncErr: any) {
        memoryLogger.warn(`删除监控目标后同步监控密钥失败: ${syncErr.message}`, 'Config');
      }
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除健康监控目标失败: ${error.message}`, 'Config');
      throw error;
    }
  });

}
