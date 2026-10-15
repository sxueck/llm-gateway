/**
 * 系统告警采集：按需计算，不落库。
 *
 * 设计取舍：
 * - 告警是“当前环境的健康快照”，条件消失即自动清除；已读状态单独落在 alert_reads 表（按用户）。
 * - 每个检查彼此独立并用 allSettled 兜底：一次 DB 抖动不能让铃铛整体失灵。
 * - 文案由前端按 code 走 i18n，这里只给 code + 参数 + 一句中文摘要（供日志/API 直读）。
 */
import Docker from 'dockerode';
import { modelDb, apiRequestDb } from '../db/index.js';
import { backupDb } from '../db/backup.js';
import { getMaxBufferSize, getBufferSize } from '../db/utils/buffer.js';
import { agentMetricsRepository } from '../db/repositories/agent-metrics.repository.js';
import { CircuitState, circuitBreaker } from './circuit-breaker.js';
import { costMappingService } from './cost-mapping.js';
import { modelPresetsService } from './model-presets.js';
import { memoryLogger } from './logger.js';
import { searchRunScheduler } from '../agent/run/scheduler.js';

export type AlertLevel = 'error' | 'warning' | 'info';

export interface SystemAlert {
  /** 稳定标识，前端据此取 i18n 文案；同一条件重复采集得到同一个 code */
  code: string;
  level: AlertLevel;
  category: 'worker' | 'cost' | 'provider' | 'storage';
  /** 中文摘要；前端优先用 code 渲染本地化文案 */
  message: string;
  /** 文案参数（镜像名、模型名、阈值……） */
  params?: Record<string, string | number>;
  /** 同类合并后的数量（如一次列出多个熔断供应商） */
  count?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 预设缓存超过一天就该提醒刷新：牌价与型号都在漂移。 */
const PRESET_STALE_MS = DAY_MS;
/** 超过这个天数没有成功备份就告警（与每日备份计划的默认容错一致）。 */
const BACKUP_STALE_DAYS = 7;
/** 写入缓冲占到该比例说明 DB 写入跟不上流量，有丢日志风险。 */
const BUFFER_PRESSURE_RATIO = 0.8;
/** 探测 Docker 的超时；超时按“不可用”处理，不能拖住整个采集。 */
const DOCKER_PROBE_TIMEOUT_MS = 3000;

const workerImage = () => (process.env.AGENT_WORKER_IMAGE || '').trim();
const workerLocalEnabled = () => process.env.AGENT_WORKER_LOCAL === '1';
/** Worker 是否“被启用”：配了镜像或开了本地执行器。 */
export function isWorkerConfigured(): boolean {
  return Boolean(workerImage()) || workerLocalEnabled();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 主机上是否存在该镜像。按 `name:tag` 与 digest 两种写法匹配；
 * 只比 `name`（无 tag）时接受任意 tag，与 dockerode 的隐式 latest 语义一致。
 */
export function imagePresentInList(
  image: string,
  images: Array<Array<string> | undefined>,
): boolean {
  const [repo, tag] = splitImageRef(image);
  for (const repoTagsOrDigests of images) {
    const refs = repoTagsOrDigests || [];
    for (const ref of refs) {
      if (ref === image) return true;
      const [refRepo, refTag] = splitImageRef(ref);
      if (refRepo !== repo) continue;
      if (!tag || refTag === tag) return true;
      // digest 引用（sha256:...）命中即视为同一镜像
      if (ref.startsWith('sha256:')) return true;
    }
  }
  return false;
}

function splitImageRef(ref: string): [string, string] {
  const at = ref.lastIndexOf(':');
  // 没有冒号，或冒号出现在端口/registry 分隔之前（如 ghcr.io/x/y）时视为无 tag
  if (at <= 0 || ref.slice(at + 1).includes('/')) return [ref, ''];
  return [ref.slice(0, at), ref.slice(at + 1)];
}

async function checkWorkerRuntime(): Promise<SystemAlert[]> {
  const alerts: SystemAlert[] = [];
  const image = workerImage();

  if (!isWorkerConfigured()) {
    // 没配执行器时只有在“真的有人提交 run”时才需要提醒，否则是噪声
    const totals = await agentMetricsRepository.getRunTotals({
      startTime: Date.now() - DAY_MS,
      endTime: Date.now(),
    });
    if (totals.runs > 0) {
      alerts.push({
        code: 'worker_executor_missing',
        level: 'error',
        category: 'worker',
        message: `已启用 Worker 但未配置执行器，近 24 小时 ${totals.runs} 个 run 无法执行（设置 AGENT_WORKER_IMAGE 或 AGENT_WORKER_LOCAL=1）`,
        params: { runs: totals.runs },
      });
    }
    return alerts;
  }

  if (!image) {
    // 本地子进程执行器：不依赖 Docker 镜像，无需探测
    return alerts;
  }

  let docker: { listImages(): Promise<Array<{ RepoTags?: string[]; RepoDigests?: string[] }>> };
  try {
    docker = new Docker();
    const listed = await withTimeout(docker.listImages(), DOCKER_PROBE_TIMEOUT_MS, 'docker listImages');
    const present = imagePresentInList(image, listed.map(item => item.RepoTags));
    if (!present) {
      const digests = listed.some(item =>
        imagePresentInList(image, [item.RepoDigests]),
      );
      if (!digests) {
        alerts.push({
          code: 'worker_image_missing',
          level: 'error',
          category: 'worker',
          message: `主机上不存在 Worker 镜像 ${image}，craft-agent run 会直接失败；请先 docker pull ${image}`,
          params: { image },
        });
      }
    }
  } catch (error: any) {
    alerts.push({
      code: 'worker_docker_unavailable',
      level: 'error',
      category: 'worker',
      message: `已启用 Worker 但无法访问 Docker 守护进程（检查 /var/run/docker.sock 挂载）：${error?.message || error}`,
      params: { image },
    });
    // Docker 都连不上就没必要再看队列了
    return alerts;
  }

  const totals = await agentMetricsRepository.getRunTotals({
    startTime: Date.now() - DAY_MS,
    endTime: Date.now(),
  });
  if (totals.failed > 0) {
    alerts.push({
      code: 'worker_run_failed',
      level: 'warning',
      category: 'worker',
      message: `近 24 小时有 ${totals.failed} 个 Worker run 失败`,
      params: { failed: totals.failed, runs: totals.runs },
      count: totals.failed,
    });
  }

  const concurrency = Number(process.env.AGENT_SEARCH_CONCURRENCY || 2);
  const depth = searchRunScheduler.queueDepth();
  if (depth >= concurrency && totals.queued > 0) {
    alerts.push({
      code: 'worker_queue_saturated',
      level: 'warning',
      category: 'worker',
      message: `Worker 并发已满（${depth}/${concurrency}），${totals.queued} 个 run 在排队`,
      params: { depth, concurrency, queued: totals.queued },
    });
  }

  return alerts;
}

async function checkCost(): Promise<SystemAlert[]> {
  const alerts: SystemAlert[] = [];
  const stats = modelPresetsService.getStats();

  if (stats.totalModels === 0) {
    alerts.push({
      code: 'model_preset_unavailable',
      level: 'error',
      category: 'cost',
      message: '模型定价预设库为空，所有成本统计都会记为 0',
    });
  } else if (stats.cacheAge > PRESET_STALE_MS) {
    alerts.push({
      code: 'model_preset_stale',
      level: 'warning',
      category: 'cost',
      message: `模型定价预设已 ${Math.round(stats.cacheAge / 3600000)} 小时未更新，牌价可能过期`,
      params: { hours: Math.round(stats.cacheAge / 3600000), total: stats.totalModels },
      count: stats.totalModels,
    });
  }

  // 有流量但取不到牌价的模型：这部分成本被静默记成 0，是最容易骗人的统计误差
  const now = Date.now();
  const modelStats = await apiRequestDb.getModelStats({
    startTime: now - 7 * DAY_MS,
    endTime: now,
    sortBy: 'tokens',
    uniqueModels: true,
    limit: null,
  });
  const models = (modelStats as Array<{ model: string; totalTokens?: number }>) || [];
  const unpriced: string[] = [];
  for (const row of models) {
    if (!row.model) continue;
    const resolved = await costMappingService.resolveModelCost(row.model);
    if (!resolved) unpriced.push(row.model);
  }
  if (unpriced.length > 0) {
    alerts.push({
      code: 'model_price_missing',
      level: 'warning',
      category: 'cost',
      message: `${unpriced.length} 个有流量的模型取不到牌价，成本按 0 计：${unpriced.slice(0, 5).join(', ')}`,
      params: { count: unpriced.length, models: unpriced.slice(0, 5).join(', ') },
      count: unpriced.length,
    });
  }

  // 已配置但永远不会有成本的模型（虚拟模型本身不计价，跳过）
  const configured = await modelDb.getAll();
  const brokenPricing: string[] = [];
  for (const model of configured) {
    if (model.is_virtual === 1 || model.enabled !== 1) continue;
    const attrs = parseAttributes(model.model_attributes);
    if (hasOwnPrice(attrs)) continue;

    const modelName = model.model_identifier || model.name;
    if (modelPresetsService.resolvePreset(modelName)) continue;
    if (await costMappingService.resolveModelCost(modelName)) continue;
    brokenPricing.push(modelName);
  }
  if (brokenPricing.length > 0) {
    alerts.push({
      code: 'model_pricing_unmapped',
      level: 'info',
      category: 'cost',
      message: `${brokenPricing.length} 个已启用模型既无自带单价也不在预设库里：${brokenPricing.slice(0, 5).join(', ')}`,
      params: { count: brokenPricing.length, models: brokenPricing.slice(0, 5).join(', ') },
      count: brokenPricing.length,
    });
  }

  return alerts;
}

function parseAttributes(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hasOwnPrice(attrs: Record<string, unknown>): boolean {
  const positive = (v: unknown) => typeof v === 'number' && v > 0;
  return positive(attrs.input_cost_per_token) || positive(attrs.output_cost_per_token);
}

function checkProviders(): SystemAlert[] {
  const open: string[] = [];
  const failing: string[] = [];
  for (const [key, stats] of circuitBreaker.getAllStats()) {
    if (stats.state === CircuitState.OPEN) open.push(key);
    else if (stats.failures >= 3) failing.push(key);
  }

  const alerts: SystemAlert[] = [];
  if (open.length > 0) {
    alerts.push({
      code: 'provider_circuit_open',
      level: 'error',
      category: 'provider',
      message: `${open.length} 个供应商处于熔断状态：${open.slice(0, 5).join(', ')}`,
      params: { count: open.length, keys: open.slice(0, 5).join(', ') },
      count: open.length,
    });
  }
  if (failing.length > 0) {
    alerts.push({
      code: 'provider_degraded',
      level: 'warning',
      category: 'provider',
      message: `${failing.length} 个供应商连续失败偏多，尚未熔断：${failing.slice(0, 5).join(', ')}`,
      params: { count: failing.length, keys: failing.slice(0, 5).join(', ') },
      count: failing.length,
    });
  }
  return alerts;
}

async function checkStorage(): Promise<SystemAlert[]> {
  const alerts: SystemAlert[] = [];

  // 写入缓冲是流量与 DB 之间唯一的削峰层，快满了就是在丢日志
  const max = getMaxBufferSize();
  const size = getBufferSize();
  if (max > 0 && size / max >= BUFFER_PRESSURE_RATIO) {
    alerts.push({
      code: 'api_request_buffer_backlog',
      level: 'warning',
      category: 'storage',
      message: `API 请求日志写入缓冲积压 ${size}/${max}，超出后会丢弃记录`,
      params: { size, max },
    });
  }

  const lastBackup = await backupDb.getLastCompletedBackup().catch(() => null);
  if (!lastBackup?.completed_at) {
    alerts.push({
      code: 'backup_missing',
      level: 'warning',
      category: 'storage',
      message: '未找到任何成功完成的备份记录',
    });
  } else {
    const ageDays = Math.floor((Date.now() - lastBackup.completed_at) / DAY_MS);
    if (ageDays >= BACKUP_STALE_DAYS) {
      alerts.push({
        code: 'backup_stale',
        level: 'warning',
        category: 'storage',
        message: `距上次成功备份已 ${ageDays} 天`,
        params: { days: ageDays },
      });
    }
  }

  return alerts;
}

/** 全部检查并发跑，单个失败只丢它自己那一条告警。 */
async function runChecks(): Promise<SystemAlert[]> {
  const checks = [
    checkWorkerRuntime(),
    checkCost(),
    Promise.resolve(checkProviders()),
    checkStorage(),
  ];
  const settled = await Promise.allSettled(checks);
  const alerts: SystemAlert[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      alerts.push(...result.value);
    } else {
      memoryLogger.warn(
        `告警检查第 ${index + 1} 项失败: ${result.reason?.message || result.reason}`,
        'Alerts',
      );
    }
  });

  const order: Record<AlertLevel, number> = { error: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * 采集结果缓存一段时间。告警是环境健康快照，变化以分钟计；
 * 而完整的采集会探测 Docker 并对有流量的模型逐个取价，不能被铃铛的轮询频率放大。
 */
const ALERTS_TTL_MS = 30_000;
let cached: { at: number; alerts: SystemAlert[] } | null = null;
let inflight: Promise<SystemAlert[]> | null = null;

export async function collectAlerts(options?: { fresh?: boolean }): Promise<SystemAlert[]> {
  const now = Date.now();
  if (!options?.fresh && cached && now - cached.at < ALERTS_TTL_MS) {
    return cached.alerts;
  }
  // 并发请求（多个标签页同时轮询）共跑一次
  if (!inflight) {
    inflight = runChecks().then(alerts => {
      cached = { at: Date.now(), alerts };
      inflight = null;
      return alerts;
    });
  }
  return inflight;
}
