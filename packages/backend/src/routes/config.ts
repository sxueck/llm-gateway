import { FastifyInstance } from "fastify";
import { appConfig, setPublicUrl, validatePublicUrl } from "../config/index.js";
import { memoryLogger } from "../services/logger.js";
import {
  apiRequestDb,
  routingConfigDb,
  modelDb,
  systemConfigDb,
  expertRoutingLogDb,
  virtualKeyDb,
} from "../db/index.js";
import { hotConfigCache } from "../services/hot-config-cache.js";
import { nanoid } from "nanoid";
import {
  loadAntiBotConfig,
  validateUserAgentList,
} from "../utils/anti-bot-config.js";
import { debugModeService } from "../services/debug-mode.js";
import { costMappingService } from "../services/cost-mapping.js";
import { runtimeSystemConfigCache } from "../services/runtime-system-config-cache.js";
import { threatIpBlocker } from "../services/threat-ip-blocker.js";
import { manualIpBlocklist } from "../services/manual-ip-blocklist.js";
import { requestHeaderForwardingService } from "../services/request-header-forwarding.js";
import { upstreamSslConfigService } from "../services/upstream-ssl-config.js";
import {
  reasoningEffortSuffixesCache,
  normalizeSuffixes,
  DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES,
  REASONING_EFFORT_SUFFIXES_CONFIG_KEY,
} from "../services/reasoning-effort-suffixes.js";
import { getGeoInfo, normalizeIp } from "../utils/ip.js";
import { getShanghaiDayStart } from "../db/utils/time-buckets.js";
import { circuitBreaker } from "../services/circuit-breaker.js";
import {
  getTargetKey,
  getAnonymousAffinityTargetKey,
  countExplicitSessionBindings,
} from "./proxy/routing.js";

export async function configRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  type StatsPeriod = "24h" | "7d" | "30d" | "all";

  function resolveStatsStartTime(period: StatsPeriod) {
    const now = Date.now();

    switch (period) {
      case "7d":
        // 与运维监控对齐：精确滚动窗口（半开区间 [now-7d, now)），
        // 不再按上海自然日零点近似，保证首页与运维页同标签同数字。
        return { now, startTime: now - 7 * 24 * 60 * 60 * 1000 };
      case "30d":
        return { now, startTime: now - 30 * 24 * 60 * 60 * 1000 };
      case "all":
        // 历史全量口径保持独立：自然日汇总服务此入口，不宣称精确滚动。
        return { now, startTime: 0 };
      default:
        return { now, startTime: now - 24 * 60 * 60 * 1000 };
    }
  }

  async function getStatsOverview(period: StatsPeriod) {
    const { now, startTime } = resolveStatsStartTime(period);
    const stats = await apiRequestDb.getStats({ startTime, endTime: now });
    const dbSize = await apiRequestDb.getDbSize();
    const dbUptime = await apiRequestDb.getDbUptime();

    return {
      now,
      startTime,
      stats: {
        ...stats,
        dbSize,
        dbUptime,
      },
    };
  }

  fastify.get("/system-settings", async () => {
    const allowRegCfg = await systemConfigDb.get("allow_registration");
    const corsEnabledCfg = await systemConfigDb.get("cors_enabled");
    const publicUrlCfg = await systemConfigDb.get("public_url");
    const litellmCompatCfg = await systemConfigDb.get("litellm_compat_enabled");
    const streamResumeCfg = await systemConfigDb.get("stream_resume_enabled");
    const debugEnabledCfg = await systemConfigDb.get("developer_debug_enabled");
    const debugExpiresCfg = await systemConfigDb.get(
      "developer_debug_expires_at",
    );
    const dashboardHideRequestSourceCardCfg = await systemConfigDb.get(
      "dashboard_hide_request_source_card",
    );
    const forwardClientUserAgentCfg = await systemConfigDb.get(
      "forward_client_user_agent",
    );
    const skipUpstreamSslVerifyCfg = await systemConfigDb.get(
      "skip_upstream_ssl_verify",
    );
    const trafficAnalysisRegionCfg = await systemConfigDb.get(
      "traffic_analysis_region",
    );
    const antiBot = await loadAntiBotConfig();

    const reasoningSuffixesCfg = await systemConfigDb.get(
      REASONING_EFFORT_SUFFIXES_CONFIG_KEY,
    );
    const reasoningEffortModelSuffixes = reasoningSuffixesCfg
      ? normalizeSuffixes(reasoningSuffixesCfg.value)
      : [...DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES];

    const now = Date.now();
    const rawExpiresAt = debugExpiresCfg ? Number(debugExpiresCfg.value) : 0;
    const activeDebug = debugEnabledCfg?.value === "true" && rawExpiresAt > now;

    return {
      allowRegistration: !(allowRegCfg && allowRegCfg.value === "false"),
      corsEnabled: corsEnabledCfg ? corsEnabledCfg.value === "true" : true,
      publicUrl: publicUrlCfg ? publicUrlCfg.value : appConfig.defaultPublicUrl,
      litellmCompatEnabled: litellmCompatCfg
        ? litellmCompatCfg.value === "true"
        : false,
      streamResumeEnabled: streamResumeCfg
        ? streamResumeCfg.value === "true"
        : false,
      developerDebugEnabled: activeDebug,
      developerDebugExpiresAt: activeDebug ? rawExpiresAt : null,
      dashboardHideRequestSourceCard: dashboardHideRequestSourceCardCfg
        ? dashboardHideRequestSourceCardCfg.value === "true"
        : false,
      forwardClientUserAgent: forwardClientUserAgentCfg
        ? forwardClientUserAgentCfg.value === "true"
        : false,
      skipUpstreamSslVerify: skipUpstreamSslVerifyCfg
        ? skipUpstreamSslVerifyCfg.value === "true"
        : false,
      trafficAnalysisRegion: trafficAnalysisRegionCfg?.value || null,
      antiBot,
      reasoningEffortModelSuffixes,
    };
  });

  fastify.get("/request-sources/lookup", async (request, reply) => {
    const { ip } = request.query as { ip?: string };
    if (!ip) {
      return reply.code(400).send({
        error: {
          message: "IP 地址不能为空",
          type: "invalid_request_error",
          param: "ip",
          code: "invalid_ip",
        },
      });
    }

    const normalizedIp = normalizeIp(ip);
    if (!normalizedIp) {
      return reply.code(400).send({
        error: {
          message: "无效的 IP 地址",
          type: "invalid_request_error",
          param: "ip",
          code: "invalid_ip_format",
        },
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

  fastify.post("/request-sources/block", async (request, reply) => {
    const { ip, reason } = request.body as { ip?: string; reason?: string };
    if (!ip) {
      return reply.code(400).send({
        error: {
          message: "IP 地址不能为空",
          type: "invalid_request_error",
          param: "ip",
          code: "invalid_ip",
        },
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
        },
      };
    } catch (error: any) {
      memoryLogger.error(
        `手动拦截 IP 失败: ${error?.message || error}`,
        "ManualBlock",
      );
      return reply.code(400).send({
        error: {
          message: error?.message || "拦截 IP 失败",
          type: "invalid_request_error",
          param: "ip",
          code: "block_ip_failed",
        },
      });
    }
  });

  fastify.post("/system-settings/refresh-threat-ip", async () => {
    try {
      await threatIpBlocker.refresh();
      return { success: true, message: "威胁 IP 列表已刷新" };
    } catch (error: any) {
      memoryLogger.error(
        `手动刷新威胁 IP 列表失败: ${error.message}`,
        "Config",
      );
      throw error;
    }
  });

  fastify.post("/system-settings", async (request) => {
    const {
      allowRegistration,
      corsEnabled,
      publicUrl,
      litellmCompatEnabled,
      streamResumeEnabled,
      developerDebugEnabled,
      dashboardHideRequestSourceCard,
      forwardClientUserAgent,
      skipUpstreamSslVerify,
      trafficAnalysisRegion,
      antiBot,
      reasoningEffortModelSuffixes,
    } = request.body as {
      allowRegistration?: boolean;
      corsEnabled?: boolean;
      publicUrl?: string;
      litellmCompatEnabled?: boolean;
      streamResumeEnabled?: boolean;
      developerDebugEnabled?: boolean;
      dashboardHideRequestSourceCard?: boolean;
      forwardClientUserAgent?: boolean;
      skipUpstreamSslVerify?: boolean;
      trafficAnalysisRegion?: string | null;
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
      reasoningEffortModelSuffixes?: string[];
    };

    try {
      if (allowRegistration !== undefined) {
        await systemConfigDb.set(
          "allow_registration",
          allowRegistration ? "true" : "false",
          "是否允许新用户注册",
        );
        const verify = await systemConfigDb.get("allow_registration");
        if (
          !verify ||
          verify.value !== (allowRegistration ? "true" : "false")
        ) {
          throw new Error("注册配置保存失败");
        }
      }

      if (corsEnabled !== undefined) {
        await systemConfigDb.set(
          "cors_enabled",
          corsEnabled ? "true" : "false",
          "是否启用 CORS 跨域支持",
        );
        const verify = await systemConfigDb.get("cors_enabled");
        if (!verify || verify.value !== (corsEnabled ? "true" : "false")) {
          throw new Error("CORS 配置保存失败");
        }
        runtimeSystemConfigCache.setCorsEnabled(corsEnabled);
        memoryLogger.info(
          `CORS 配置已更新: ${corsEnabled ? "启用" : "禁用"}`,
          "Config",
        );
      }

      if (litellmCompatEnabled !== undefined) {
        await systemConfigDb.set(
          "litellm_compat_enabled",
          litellmCompatEnabled ? "true" : "false",
          "是否启用 LiteLLM 兼容模式",
        );
        const verify = await systemConfigDb.get("litellm_compat_enabled");
        if (
          !verify ||
          verify.value !== (litellmCompatEnabled ? "true" : "false")
        ) {
          throw new Error("LiteLLM 兼容模式配置保存失败");
        }
        memoryLogger.info(
          `LiteLLM 兼容模式已更新: ${litellmCompatEnabled ? "启用" : "禁用"}`,
          "Config",
        );
      }

      if (streamResumeEnabled !== undefined) {
        await systemConfigDb.set(
          "stream_resume_enabled",
          streamResumeEnabled ? "true" : "false",
          "是否启用流式断点续传：上游流中断时携带已输出内容自动续写",
        );
        const verify = await systemConfigDb.get("stream_resume_enabled");
        if (
          !verify ||
          verify.value !== (streamResumeEnabled ? "true" : "false")
        ) {
          throw new Error("流式断点续传配置保存失败");
        }
        memoryLogger.info(
          `流式断点续传已更新: ${streamResumeEnabled ? "启用" : "禁用"}`,
          "Config",
        );
      }

      // Developer debug mode: 15 minutes temporary window
      if (developerDebugEnabled !== undefined) {
        if (developerDebugEnabled) {
          const expiresAt = Date.now() + 15 * 60 * 1000;
          await systemConfigDb.set(
            "developer_debug_enabled",
            "true",
            "是否启用开发者调试模式",
          );
          await systemConfigDb.set(
            "developer_debug_expires_at",
            String(expiresAt),
            "开发者调试模式到期时间",
          );
          debugModeService.setState(true, expiresAt);
          memoryLogger.warn(
            `开发者调试模式已开启，将在 ${new Date(expiresAt).toLocaleString("zh-CN")} 自动关闭`,
            "Config",
          );
        } else {
          await systemConfigDb.set(
            "developer_debug_enabled",
            "false",
            "是否启用开发者调试模式",
          );
          await systemConfigDb.set(
            "developer_debug_expires_at",
            "0",
            "开发者调试模式到期时间",
          );
          debugModeService.setState(false, Date.now());
          memoryLogger.info("开发者调试模式已关闭", "Config");
        }
      }

      if (dashboardHideRequestSourceCard !== undefined) {
        await systemConfigDb.set(
          "dashboard_hide_request_source_card",
          dashboardHideRequestSourceCard ? "true" : "false",
          "是否在首页隐藏「请求来源」",
        );
      }

      if (forwardClientUserAgent !== undefined) {
        await systemConfigDb.set(
          "forward_client_user_agent",
          forwardClientUserAgent ? "true" : "false",
          "是否向上游透传客户端 User-Agent",
        );
        await requestHeaderForwardingService.reloadConfig();
        memoryLogger.info(
          `客户端 User-Agent 透传已更新: ${forwardClientUserAgent ? "启用" : "禁用"}`,
          "Config",
        );
      }

      if (skipUpstreamSslVerify !== undefined) {
        await systemConfigDb.set(
          "skip_upstream_ssl_verify",
          skipUpstreamSslVerify ? "true" : "false",
          "Skip upstream SSL certificate verification",
        );
        await upstreamSslConfigService.reloadConfig();
        memoryLogger.info(
          `Skip upstream SSL verification updated: ${skipUpstreamSslVerify ? "enabled" : "disabled"}`,
          "Config",
        );
      }

      if (trafficAnalysisRegion !== undefined) {
        await systemConfigDb.set(
          "traffic_analysis_region",
          trafficAnalysisRegion || "",
          "流量分析地区 (ISO 3166-1 alpha-2)",
        );
        memoryLogger.info(
          `流量分析地区已更新: ${trafficAnalysisRegion || "未设置"}`,
          "Config",
        );
      }

      if (publicUrl !== undefined) {
        const validation = validatePublicUrl(publicUrl);
        if (!validation.valid) {
          throw new Error(validation.error);
        }

        await systemConfigDb.set(
          "public_url",
          publicUrl,
          "LLM Gateway 公网访问地址",
        );
        const verify = await systemConfigDb.get("public_url");
        if (!verify || verify.value !== publicUrl) {
          throw new Error("公网地址配置保存失败");
        }
        setPublicUrl(publicUrl);
        memoryLogger.info(`LLM Gateway URL 已更新: ${publicUrl}`, "Config");
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
          await systemConfigDb.set(
            "anti_bot_enabled",
            antiBot.enabled ? "true" : "false",
            "是否启用反爬虫功能",
          );
          memoryLogger.info(
            `反爬虫功能已更新: ${antiBot.enabled ? "启用" : "禁用"}`,
            "Config",
          );
        }
        if (antiBot.blockBots !== undefined) {
          await systemConfigDb.set(
            "anti_bot_block_bots",
            antiBot.blockBots ? "true" : "false",
            "是否拦截爬虫",
          );
        }
        if (antiBot.blockSuspicious !== undefined) {
          await systemConfigDb.set(
            "anti_bot_block_suspicious",
            antiBot.blockSuspicious ? "true" : "false",
            "是否拦截可疑请求",
          );
        }
        if (antiBot.blockThreatIPs !== undefined) {
          await systemConfigDb.set(
            "anti_bot_block_threat_ips",
            antiBot.blockThreatIPs ? "true" : "false",
            "是否拦截威胁IP",
          );
          memoryLogger.info(
            `威胁 IP 拦截已更新: ${antiBot.blockThreatIPs ? "启用" : "禁用"}`,
            "Config",
          );
        }
        if (antiBot.logOnly !== undefined) {
          await systemConfigDb.set(
            "anti_bot_log_only",
            antiBot.logOnly ? "true" : "false",
            "是否仅记录日志不拦截",
          );
        }
        if (antiBot.logHeaders !== undefined) {
          await systemConfigDb.set(
            "anti_bot_log_headers",
            antiBot.logHeaders ? "true" : "false",
            "是否在日志中记录完整请求头",
          );
          memoryLogger.info(
            `反爬虫请求头记录已更新: ${antiBot.logHeaders ? "启用" : "禁用"}`,
            "Config",
          );
        }
        if (antiBot.allowedUserAgents !== undefined) {
          await systemConfigDb.set(
            "anti_bot_allowed_user_agents",
            antiBot.allowedUserAgents.join(","),
            "白名单User-Agent列表",
          );
        }
        if (antiBot.blockedUserAgents !== undefined) {
          await systemConfigDb.set(
            "anti_bot_blocked_user_agents",
            antiBot.blockedUserAgents.join(","),
            "黑名单User-Agent列表",
          );
        }

        const { antiBotService } = await import("../services/anti-bot.js");
        await antiBotService.reloadConfig();

        const reloadedConfig = await loadAntiBotConfig();
        if (
          antiBot.enabled !== undefined &&
          reloadedConfig.enabled !== antiBot.enabled
        ) {
          throw new Error("反爬虫配置保存验证失败");
        }
      }

      if (reasoningEffortModelSuffixes !== undefined) {
        const normalized = normalizeSuffixes(reasoningEffortModelSuffixes);
        await systemConfigDb.set(
          REASONING_EFFORT_SUFFIXES_CONFIG_KEY,
          JSON.stringify(normalized),
          "模型名后缀 reasoning_effort 白名单（JSON 数组）",
        );
        await reasoningEffortSuffixesCache.reload();
        memoryLogger.info(
          `reasoning_effort 后缀白名单已更新: [${normalized.join(", ")}]`,
          "Config",
        );
      }

      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`系统配置更新失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.get("/logs", async (request) => {
    const {
      level,
      limit = 100,
      search,
    } = request.query as {
      level?: "INFO" | "WARN" | "ERROR" | "DEBUG";
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

  async function calculateCostStats(startTime: number, endTime: number) {
    const pool = await import("../db/connection.js").then((m) =>
      m.getDatabase(),
    );
    const conn = await pool.getConnection();
    try {
      const detailStart = getShanghaiDayStart(
        -appConfig.apiRequestLogRetentionDays,
      );
      const needsSummary = startTime < detailStart;
      const needsDetail = endTime >= detailStart;

      // 使用 Map 聚合各模型的 token 使用情况
      const modelUsageMap = new Map<
        string,
        {
          promptTokens: number;
          completionTokens: number;
          cachedTokens: number;
        }
      >();

      if (needsSummary) {
        const lastSummaryDay = new Date(detailStart - 1);
        const [summaryRows] = await conn.query(
          `SELECT
            s.model,
            SUM(s.prompt_tokens) as total_prompt_tokens,
            SUM(s.completion_tokens) as total_completion_tokens,
            SUM(s.cached_tokens) as total_cached_tokens
          FROM api_request_daily_summaries s
          LEFT JOIN virtual_keys vk ON s.virtual_key_id = vk.id
          WHERE s.summary_date >= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND s.summary_date <= DATE(FROM_UNIXTIME(? / 1000) + INTERVAL 8 HOUR)
            AND (s.virtual_key_id = '' OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)
          GROUP BY s.model`,
          [startTime, lastSummaryDay.getTime()],
        );

        for (const row of summaryRows as any[]) {
          if (!row.model) continue;
          const existing = modelUsageMap.get(row.model) || {
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
          };
          existing.promptTokens += Number(row.total_prompt_tokens) || 0;
          existing.completionTokens += Number(row.total_completion_tokens) || 0;
          existing.cachedTokens += Number(row.total_cached_tokens) || 0;
          modelUsageMap.set(row.model, existing);
        }
      }

      if (needsDetail) {
        const detailStartTime = Math.max(startTime, detailStart);
        const [detailRows] = await conn.query(
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
          [detailStartTime, endTime],
        );

        for (const row of detailRows as any[]) {
          if (!row.model) continue;
          const existing = modelUsageMap.get(row.model) || {
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
          };
          existing.promptTokens += Number(row.total_prompt_tokens) || 0;
          existing.completionTokens += Number(row.total_completion_tokens) || 0;
          existing.cachedTokens += Number(row.total_cached_tokens) || 0;
          modelUsageMap.set(row.model, existing);
        }
      }

      let totalCost = 0;
      const modelCosts: any[] = [];

      for (const [model, usage] of modelUsageMap.entries()) {
        const costInfo = await costMappingService.resolveModelCost(model);

        if (costInfo && costInfo.info) {
          const info = costInfo.info;
          let modelCost = 0;

          if (info.input_cost_per_token && usage.promptTokens) {
            modelCost += usage.promptTokens * Number(info.input_cost_per_token);
          }

          if (info.output_cost_per_token && usage.completionTokens) {
            modelCost +=
              usage.completionTokens * Number(info.output_cost_per_token);
          }

          // 使用模型定义的缓存读取成本，若未定义则使用输入成本作为回退
          if (usage.cachedTokens) {
            const cacheReadCostPerToken =
              info.cache_read_cost_per_token ?? info.input_cost_per_token;
            if (cacheReadCostPerToken) {
              modelCost += usage.cachedTokens * Number(cacheReadCostPerToken);
            }
          }

          totalCost += modelCost;

          if (modelCost > 0) {
            modelCosts.push({
              model,
              cost: modelCost,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              cachedTokens: usage.cachedTokens,
            });
          }
        }
      }

      modelCosts.sort((a, b) => b.cost - a.cost);

      return {
        totalCost,
        modelCosts: modelCosts.slice(0, 10), // 返回前 10 个最贵的模型
      };
    } finally {
      conn.release();
    }
  }

  fastify.get("/stats", async (request) => {
    const { period = "24h", metric = "requests" } = request.query as {
      period?: StatsPeriod;
      metric?: "requests" | "tokens";
    };
    const { now, startTime, stats } = await getStatsOverview(period);
    const trend = await apiRequestDb.getTrend({
      startTime,
      endTime: now,
      interval: period === "24h" ? "hour" : "day",
    });
    const piiProtectionCount = await apiRequestDb.getPiiProtectionCount({
      startTime,
      endTime: now,
    });

    const intentClassifyStats = await expertRoutingLogDb.getGlobalStatistics(startTime);
    const modelStats = await apiRequestDb.getModelStats({
      startTime,
      endTime: now,
      sortBy: metric,
      limit: 10,
    });
    const modelResponseTimeStats = await apiRequestDb.getModelResponseTimeStats(
      { startTime, endTime: now },
    );
    // 熔断器统计改为从数据库获取持久化结果，并传递时间范围参数
    const circuitBreakerStats =
      await import("../db/repositories/circuit-breaker-stats.repository.js").then(
        (m) => m.circuitBreakerStatsRepository.getGlobalStats(startTime),
      );

    const lastRequest = await apiRequestDb.getLastRequest();
    const manualLastBlocked = manualIpBlocklist.getLastBlocked();
    const threatIpStats = threatIpBlocker.getStats();
    const threatLastBlocked = threatIpStats.lastBlockedIp
      ? {
          ip: threatIpStats.lastBlockedIp,
          timestamp: threatIpStats.lastBlockedAt || 0,
          reason: null,
          source: "threat" as const,
        }
      : null;
    const lastBlockedInfo = manualLastBlocked
      ? {
          ip: manualLastBlocked.ip,
          timestamp: manualLastBlocked.createdAt,
          reason: manualLastBlocked.reason,
          source: "manual" as const,
        }
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
      type: "normal" | "blocked";
    }> = recentIps
      .filter((row: any) => !!row.ip)
      .map((row: any) => ({
        ip: row.ip,
        timestamp: row.last_seen,
        count: row.count,
        type: "normal" as const,
      }));

    if (lastBlockedInfo?.ip) {
      sourceCandidates.unshift({
        ip: lastBlockedInfo.ip,
        timestamp: lastBlockedInfo.timestamp || Date.now(),
        count: 0,
        type: "blocked",
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
          type: manualBlocked ? "blocked" : entry.type,
          geo,
          userAgent: lastRequestForIp?.user_agent || null,
          blockedReason: manualBlocked?.reason || null,
        };
      }),
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

    let costStats = null;
    try {
      costStats = await calculateCostStats(startTime, now);
    } catch (error: any) {
      memoryLogger.warn(`计算成本统计失败: ${error.message}`, "Config");
    }

    return {
      period,
      stats,
      trend,
      intentClassifyStats,
      modelStats,
      modelResponseTimeStats,
      circuitBreakerStats,
      costStats,
      requestSourceStats,
      threatIpStats,
      piiProtectionCount,
    };
  });

  fastify.get("/stats/summary", async (request) => {
    const { period = "24h" } = request.query as { period?: StatsPeriod };
    const { stats } = await getStatsOverview(period);

    return {
      period,
      stats,
    };
  });

  fastify.get("/api-requests", async (request) => {
    const {
      page = 1,
      pageSize = 20,
      startTime,
      endTime,
      status,
      virtualKeyId,
      providerId,
      model,
      runId,
    } = request.query as {
      page?: number;
      pageSize?: number;
      startTime?: number;
      endTime?: number;
      status?: string;
      virtualKeyId?: string;
      providerId?: string;
      model?: string;
      runId?: string;
    };

    const result = await apiRequestDb.getAll({
      limit: Number(pageSize),
      offset: (Number(page) - 1) * Number(pageSize),
      startTime: startTime ? Number(startTime) : undefined,
      endTime: endTime ? Number(endTime) : undefined,
      status,
      virtualKeyId,
      providerId,
      model,
      runId,
    });

    return result;
  });

  fastify.get("/api-requests/:id", async (request) => {
    const { id } = request.params as { id: string };
    const apiRequest = await apiRequestDb.getById(id);

    if (!apiRequest) {
      throw new Error("请求记录不存在");
    }

    return apiRequest;
  });

  fastify.post("/api-requests/clean", async (request) => {
    const body = (request.body || {}) as { daysToKeep?: number };
    // 精确 30d 滚动窗口要求明细留存覆盖边界：手工清理不允许击穿留存下限。
    const retentionFloor = appConfig.apiRequestLogRetentionDays;
    const requested = body.daysToKeep ?? retentionFloor;
    const daysToKeep = Math.max(requested, retentionFloor);

    try {
      const result = await apiRequestDb.cleanOldRecords(daysToKeep);
      if (result.lockSkipped) {
        return {
          success: false,
          message: "另一个清理任务正在运行，请稍后重试",
        };
      }
      memoryLogger.info(
        `清理旧请求日志: 汇总 ${result.summarizedCount} 条，删除明细 ${result.deletedRequestCount} 条 (保留 ${daysToKeep} 天)`,
        "Config",
      );

      return {
        success: true,
        summarizedCount: result.summarizedCount,
        deletedPayloadCount: result.deletedPayloadCount,
        deletedRequestCount: result.deletedRequestCount,
        deletedCount: result.deletedCount, // For backward compatibility with frontend
        message:
          daysToKeep !== requested
            ? `保留天数已按留存下限调整为 ${daysToKeep} 天；已汇总 ${result.summarizedCount} 条并删除 ${result.deletedRequestCount} 条请求明细`
            : `已汇总 ${result.summarizedCount} 条并删除 ${result.deletedRequestCount} 条超过 ${daysToKeep} 天的请求明细`,
      };
    } catch (error: any) {
      memoryLogger.error(`清理请求日志失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.get("/routing-configs", async () => {
    try {
      const configs = await routingConfigDb.getAll();
      return {
        configs: (configs as any[]).map((c) => ({
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
      memoryLogger.error(`获取路由配置失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.post("/routing-configs", async (request) => {
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

      memoryLogger.info(`创建路由配置: ${body.name}`, "Config");

      let virtualModel = null;
      if (body.createVirtualModel && body.virtualModelName) {
        virtualModel = await modelDb.create({
          id: nanoid(),
          name: body.virtualModelName,
          provider_id: null,
          model_identifier: `virtual-${configId}`,
          supported_protocols: null,
          is_virtual: 1,
          routing_config_id: configId,
          enabled: 1,
          model_attributes: null,
          prompt_config: null,
          compression_config: null,
        });
        memoryLogger.info(`创建虚拟模型: ${body.virtualModelName}`, "Config");
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
        virtualModel: virtualModel
          ? {
              id: virtualModel.id,
              name: virtualModel.name,
              providerId: virtualModel.provider_id,
              modelIdentifier: virtualModel.model_identifier,
              isVirtual: true,
              routingConfigId: virtualModel.routing_config_id,
            }
          : null,
      };
    } catch (error: any) {
      memoryLogger.error(`创建路由配置失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.put("/routing-configs/:id", async (request) => {
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
        throw new Error("路由配置不存在");
      }

      await routingConfigDb.update(id, {
        name: body.name,
        description: body.description,
        type: body.type,
        config: body.config ? JSON.stringify(body.config) : undefined,
      });

      const allModels = await modelDb.getAll();
      const virtualModel = allModels.find(
        (m: any) => m.routing_config_id === id && m.is_virtual === 1,
      );
      if (virtualModel && body.virtualModelName) {
        await modelDb.update(virtualModel.id, {
          name: body.virtualModelName,
        });
        hotConfigCache.invalidateModel(virtualModel.id);
      }

      memoryLogger.info(`更新路由配置: ${id}`, "Config");

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
      memoryLogger.error(`更新路由配置失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.delete("/routing-configs/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const existingConfig = await routingConfigDb.getById(id);
      if (!existingConfig) {
        throw new Error("路由配置不存在");
      }

      const associatedModels = await modelDb.getByRoutingConfigId(id);

      // 引用完整性：待删除的虚拟模型仍被虚拟密钥引用时拒绝删除，避免悬空引用
      const modelsToDelete = associatedModels.filter((m) => m.is_virtual === 1);
      if (modelsToDelete.length > 0) {
        const virtualKeyCounts = await virtualKeyDb.countByModels(
          modelsToDelete.map((m) => ({
            id: m.id,
            provider_id: m.provider_id,
            model_identifier: m.model_identifier,
            name: m.name,
          })),
        );
        const referencedModels = modelsToDelete.filter(
          (m) => (virtualKeyCounts.get(m.id) || 0) > 0,
        );
        if (referencedModels.length > 0) {
          const names = referencedModels.map((m) => m.name).join("、");
          return reply.code(400).send({
            error: `无法删除路由配置，${referencedModels.length} 个关联虚拟模型仍被虚拟密钥引用（${names}），请先解除引用后重试`,
          });
        }
      }

      let deletedModels = 0;
      let detachedModels = 0;

      for (const model of associatedModels) {
        if (model.is_virtual === 1) {
          await modelDb.delete(model.id);
          hotConfigCache.invalidateModel(model.id);
          deletedModels++;
        } else {
          await modelDb.update(model.id, { routing_config_id: null });
          hotConfigCache.invalidateModel(model.id);
          detachedModels++;
        }
      }

      await routingConfigDb.delete(id);
      memoryLogger.info(
        `删除路由配置: ${id} | 删除虚拟模型: ${deletedModels} 个 | 解绑模型: ${detachedModels} 个`,
        "Config",
      );
      return { success: true };
    } catch (error: any) {
      memoryLogger.error(`删除路由配置失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.get("/routing-status", async () => {
    try {
      const configs = await routingConfigDb.getAll();
      const result = (configs as any[]).map((c) => {
        let parsedConfig: any;
        try {
          parsedConfig = JSON.parse(c.config);
        } catch {
          parsedConfig = { targets: [] };
        }
        const targets = parsedConfig.targets || [];
        const configId = String(c.id);
        const anonymousStickyTarget = getAnonymousAffinityTargetKey(configId);

        const targetStatuses = targets.map((target: any) => {
          const targetKey = getTargetKey(target);
          return {
            targetKey,
            circuitState: circuitBreaker.getState(targetKey),
            isAnonymousAffinitySelected: anonymousStickyTarget === targetKey,
            boundSessionCount: countExplicitSessionBindings(
              configId,
              targetKey,
            ),
          };
        });

        return {
          configId,
          targets: targetStatuses,
        };
      });

      return {
        configs: result,
        meta: { polledAt: new Date().toISOString() },
      };
    } catch (error: any) {
      memoryLogger.error(`获取路由状态失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.get("/performance-metrics", async () => {
    try {
      const now = Date.now();
      const startTime = now - 7 * 24 * 60 * 60 * 1000; // 7 days ago

      const metrics = await apiRequestDb.getPerformanceMetrics({
        startTime,
        endTime: now,
      });

      return {
        period: "7d",
        summary: metrics.summary,
        items: metrics.items,
        filters: metrics.filters,
      };
    } catch (error: any) {
      memoryLogger.error(`获取性能监控指标失败: ${error.message}`, "Config");
      throw error;
    }
  });

  fastify.get("/stats/traffic-analysis", async (_request, reply) => {
    try {
      const { workdayCalendarService } =
        await import("../services/workday-calendar.js");
      const { trafficPredictionService } =
        await import("../services/traffic-prediction.js");

      // Ensure holiday modules are loaded (idempotent after first call)
      await workdayCalendarService.initialize();

      const regionCfg = await systemConfigDb.get("traffic_analysis_region");
      const region = regionCfg?.value || null;

      const now = Date.now();
      const hourMs = 3600000;
      const past24Start = now - 24 * hourMs;
      const maxDays = 14;

      const [actualRaw, trainingRaw] = await Promise.all([
        apiRequestDb.getHourlyActual({ startTime: past24Start, endTime: now }),
        apiRequestDb.getHourlyTrainingData({ days: maxDays }),
      ]);

      const availableDays =
        trainingRaw.length > 0
          ? Math.ceil((now - trainingRaw[0].timestampMs) / (24 * hourMs))
          : 0;

      const lastHourStart = Math.floor(now / hourMs) * hourMs;

      const dataQuality: "insufficient" | "low" | "good" =
        availableDays < 3 ? "insufficient" : availableDays < 7 ? "low" : "good";

      const actualMap = new Map(actualRaw.map((r) => [r.timestampMs, r.count]));
      const actual: { timestamp: number; count: number }[] = [];
      for (let i = 23; i >= 0; i--) {
        const ts = lastHourStart - i * hourMs;
        actual.push({ timestamp: ts, count: actualMap.get(ts) ?? 0 });
      }

      const nextHour = lastHourStart + hourMs;
      let prediction: import("../services/traffic-prediction.js").HourlyPrediction[];
      let peaks: import("../services/traffic-prediction.js").PeakWindow[];
      let modelInfo: {
        type: "weekly-empirical";
        trainingSamples: number;
        priorStrength: number;
        workdayProfile: number[];
        nonWorkdayProfile: number[];
      };

      const trainingSamples: import("../services/traffic-prediction.js").TrainingData[] =
        [];

      if (availableDays < 3) {
        prediction = Array.from({ length: 24 }, (_, i) => ({
          timestamp: nextHour + i * hourMs,
          predictedCount: 0,
          isPeak: false,
          peakScore: 0,
          isWorkday: workdayCalendarService.isWorkday(
            nextHour + i * hourMs,
            region,
          ),
        }));
        peaks = [];
        modelInfo = {
          type: "weekly-empirical",
          trainingSamples: 0,
          priorStrength: 3,
          workdayProfile: Array(24).fill(0),
          nonWorkdayProfile: Array(24).fill(0),
        };
      } else {
        const trainingMap = new Map(
          trainingRaw.map((r) => [r.timestampMs, r.count]),
        );
        for (
          let ts = trainingRaw[0].timestampMs;
          ts <= lastHourStart;
          ts += hourMs
        ) {
          trainingSamples.push({
            timestampMs: ts,
            count: trainingMap.get(ts) ?? 0,
            isWorkday: workdayCalendarService.isWorkday(ts, region),
          });
        }

        const model =
          trafficPredictionService.trainWeeklyEmpirical(trainingSamples);

        prediction = Array.from({ length: 24 }, (_, i) => {
          const ts = nextHour + i * hourMs;
          const iwd = workdayCalendarService.isWorkday(ts, region);
          const predictedCount =
            trafficPredictionService.predictWeeklyEmpirical(model, ts, iwd);
          return {
            timestamp: ts,
            predictedCount,
            isPeak: false,
            peakScore: 0,
            isWorkday: iwd,
          };
        });

        peaks = trafficPredictionService.detectPeaks(prediction);

        const mean = prediction.reduce((s, p) => s + p.predictedCount, 0) / 24;
        for (const p of prediction) {
          p.peakScore = mean > 0 ? (p.predictedCount - mean) / mean : 0;
        }
        for (const peak of peaks) {
          for (const p of prediction) {
            if (
              p.timestamp >= peak.startTimestamp &&
              p.timestamp <= peak.endTimestamp
            ) {
              p.isPeak = true;
            }
          }
        }

        modelInfo = {
          type: "weekly-empirical",
          trainingSamples: model.trainingSamples,
          priorStrength: model.priorStrength,
          workdayProfile: trafficPredictionService.clusterProfile(model, true),
          nonWorkdayProfile: trafficPredictionService.clusterProfile(
            model,
            false,
          ),
        };
      }

      let accuracy: { r2: number; wape: number } | null = null;
      if (availableDays >= 4) {
        if (trainingSamples.length >= 48) {
          const trainSet = trainingSamples.slice(0, -24);
          const valSet = trainingSamples.slice(-24);
          const valModel =
            trafficPredictionService.trainWeeklyEmpirical(trainSet);
          const predicted = valSet.map((v) =>
            trafficPredictionService.predictWeeklyEmpirical(
              valModel,
              v.timestampMs,
              v.isWorkday,
            ),
          );
          const actualValues = valSet.map((v) => v.count);
          const mean =
            actualValues.reduce((s, v) => s + v, 0) / actualValues.length;
          const ssTot = actualValues.reduce(
            (sum, y) => sum + (y - mean) ** 2,
            0,
          );
          const ssRes = actualValues.reduce(
            (sum, y, i) => sum + (y - predicted[i]) ** 2,
            0,
          );
          const r2 =
            ssTot === 0
              ? ssRes === 0
                ? 1
                : 0
              : Math.max(0, 1 - ssRes / ssTot);
          // WAPE（按量加权绝对百分比误差）：Σ|实际-预测| / Σ实际。
          // 相比 MAPE 不会被低谷小数值放大，对低流量网关更能反映真实预测质量。
          let absErrorSum = 0;
          let actualSum = 0;
          for (let i = 0; i < actualValues.length; i++) {
            absErrorSum += Math.abs(actualValues[i] - predicted[i]);
            actualSum += actualValues[i];
          }
          const wape = actualSum > 0 ? (absErrorSum / actualSum) * 100 : 0;
          accuracy = {
            r2: Math.round(r2 * 1000) / 1000,
            wape: Math.round(wape * 10) / 10,
          };
        }
      }

      return {
        actual,
        prediction,
        peaks,
        dataQuality,
        availableDays,
        region,
        modelInfo,
        accuracy,
        generatedAt: now,
      };
    } catch (error: any) {
      memoryLogger.error(`流量分析失败: ${error?.message}`, "TrafficAnalysis");
      return reply.code(500).send({
        error: {
          message: error?.message || "流量分析失败",
          type: "internal_error",
          code: "traffic_analysis_error",
        },
      });
    }
  });

  fastify.get<{ Querystring: { dayOffset?: string } }>(
    "/stats/traffic-analysis/history-day",
    async (request, reply) => {
      try {
        const dayOffset = Math.floor(
          Math.min(6, Math.max(0, Number(request.query.dayOffset) || 0)),
        );
        const { workdayCalendarService } =
          await import("../services/workday-calendar.js");
        const { trafficPredictionService } =
          await import("../services/traffic-prediction.js");

        await workdayCalendarService.initialize();

        const regionCfg = await systemConfigDb.get("traffic_analysis_region");
        const region = regionCfg?.value || null;

        const hourMs = 3600000;
        const shanghaiOffset = 8 * 3600000;
        const now = Date.now();
        const todayStartLocal =
          Math.floor((now + shanghaiOffset) / (24 * hourMs)) * (24 * hourMs) -
          shanghaiOffset;
        const dayStart = todayStartLocal - dayOffset * 24 * hourMs;
        const dayEnd = dayStart + 24 * hourMs;

        if (dayOffset > 0 && dayEnd > now) {
          return reply
            .code(400)
            .send({ error: { message: "dayOffset 超出范围" } });
        }

        const trainingRaw = await apiRequestDb.getHourlyTrainingData({
          days: 14,
        });
        if (trainingRaw.length < 72) {
          return {
            actual: [],
            predicted: [],
            dayStart,
            isWorkday: workdayCalendarService.isWorkday(dayStart, region),
          };
        }

        const trainingSamples: import("../services/traffic-prediction.js").TrainingData[] =
          [];
        const trainingMap = new Map(
          trainingRaw.map((r) => [r.timestampMs, r.count]),
        );
        const lastTrainingTs = trainingRaw[trainingRaw.length - 1].timestampMs;
        for (
          let ts = trainingRaw[0].timestampMs;
          ts <= lastTrainingTs;
          ts += hourMs
        ) {
          trainingSamples.push({
            timestampMs: ts,
            count: trainingMap.get(ts) ?? 0,
            isWorkday: workdayCalendarService.isWorkday(ts, region),
          });
        }

        const model =
          trafficPredictionService.trainWeeklyEmpirical(trainingSamples);
        const isWorkday = workdayCalendarService.isWorkday(dayStart, region);
        const profile = trafficPredictionService.clusterProfile(
          model,
          isWorkday,
        );

        const actual: { timestamp: number; count: number }[] = [];
        const predicted: { timestamp: number; predictedCount: number }[] = [];

        for (let i = 0; i < 24; i++) {
          const ts = dayStart + i * hourMs;
          actual.push({ timestamp: ts, count: trainingMap.get(ts) ?? 0 });
          predicted.push({
            timestamp: ts,
            predictedCount: Math.round(profile[i] ?? 0),
          });
        }

        return { actual, predicted, dayStart, isWorkday };
      } catch (error: any) {
        memoryLogger.error(
          `获取历史叠加数据失败: ${error?.message}`,
          "TrafficAnalysis",
        );
        return reply.code(500).send({
          error: { message: error?.message || "获取历史叠加数据失败" },
        });
      }
    },
  );

  fastify.get("/traffic-analysis-regions", async (_request, reply) => {
    try {
      const { workdayCalendarService } =
        await import("../services/workday-calendar.js");
      await workdayCalendarService.initialize();
      const countries = workdayCalendarService.getCountries();
      const cn = countries.find((c) => c.code === "CN");
      const rest = countries
        .filter((c) => c.code !== "CN")
        .sort((a, b) => a.name.localeCompare(b.name));
      return cn ? [cn, ...rest] : rest;
    } catch (error: any) {
      memoryLogger.error(
        `获取地区列表失败: ${error?.message}`,
        "TrafficAnalysis",
      );
      return reply.code(500).send({ error: { message: "获取地区列表失败" } });
    }
  });
}
