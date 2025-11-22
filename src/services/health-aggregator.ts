import { healthTargetDb, healthRunDb } from '../db/index.js';

interface TargetSummary {
  targetId: string;
  targetName: string;
  targetType: 'model' | 'virtual_model';
  currentStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  latestCheck?: {
    status: 'success' | 'error';
    timestamp: number;
    latencyMs: number;
    errorMessage?: string;
  };
  healthHistory?: Array<{
    status: 'success' | 'error';
    timestamp: number;
    latencyMs: number;
    errorMessage?: string;
  }>;
  stats1h: {
    totalChecks: number;
    successCount: number;
    errorCount: number;
    availability: number;
    avgLatency: number;
    p50Latency: number;
    p95Latency: number;
  };
  stats24h: {
    totalChecks: number;
    successCount: number;
    errorCount: number;
    availability: number;
    avgLatency: number;
    p50Latency: number;
    p95Latency: number;
  };
}

interface GlobalSummary {
  totalTargets: number;
  activeTargets: number;
  healthyTargets: number;
  degradedTargets: number;
  downTargets: number;
  overall24hAvailability: number;
  overall24hAvgLatency: number;
}

function calculatePercentiles(values: number[], percentile: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function determineStatus(runs: any[], windowMs: number): 'ok' | 'degraded' | 'down' | 'unknown' {
  if (runs.length === 0) return 'unknown';

  const now = Date.now();
  const recentRuns = runs.filter(r => now - r.created_at <= windowMs);

  if (recentRuns.length === 0) return 'unknown';

  const errorCount = recentRuns.filter(r => r.status === 'error').length;
  const totalCount = recentRuns.length;
  const errorRate = errorCount / totalCount;

  if (errorRate === 0) return 'ok';
  if (errorRate < 0.2) return 'degraded'; // <20% 错误率视为降级
  return 'down'; // >=20% 错误率视为宕机
}

class HealthAggregatorService {
  // 缓存数据，避免频繁查询
  private summaryCache: {
    data: TargetSummary[] | null;
    timestamp: number;
  } = { data: null, timestamp: 0 };

  private globalCache: {
    data: GlobalSummary | null;
    timestamp: number;
  } = { data: null, timestamp: 0 };

  private readonly CACHE_TTL_MS = 15000; // 15秒缓存

  /**
   * 获取所有目标的汇总信息
   */
  async getAllTargetsSummary(useCache = true): Promise<TargetSummary[]> {
    const now = Date.now();

    // 检查缓存
    if (useCache && this.summaryCache.data && now - this.summaryCache.timestamp < this.CACHE_TTL_MS) {
      return this.summaryCache.data;
    }

    const targets = await healthTargetDb.getEnabled();
    const summaries: TargetSummary[] = [];

    for (const target of targets) {
      const summary = await this.getTargetSummary(target.id);
      summaries.push(summary);
    }

    // 更新缓存
    this.summaryCache.data = summaries;
    this.summaryCache.timestamp = now;

    return summaries;
  }

  /**
   * 获取单个目标的汇总信息
   */
  async getTargetSummary(targetId: string): Promise<TargetSummary> {
    const target = await healthTargetDb.getById(targetId);
    if (!target) {
      throw new Error(`目标不存在: ${targetId}`);
    }

    const now = Date.now();
    const window1h = 60 * 60 * 1000;
    const window24h = 24 * 60 * 60 * 1000;

    // 获取最近24小时的数据
    const runs24h = await healthRunDb.getByTimeWindow(targetId, now - window24h, now);
    const runs1h = runs24h.filter(r => r.created_at >= now - window1h);

    // 获取最近100次检查记录用于可视化时间轴
    const recentRuns = await healthRunDb.getByTargetId(targetId, 100);

    // 计算1小时统计
    const stats1h = this.calculateStats(runs1h);

    // 计算24小时统计
    const stats24h = this.calculateStats(runs24h);

    // 获取最近一次检查
    const latestRun = runs24h.length > 0 ? runs24h[runs24h.length - 1] : null;

    // 确定当前状态（基于最近1小时的数据）
    const currentStatus = determineStatus(runs1h, window1h);

    // 转换最近的检查记录为历史数据
    const healthHistory = recentRuns.map(run => ({
      status: run.status,
      timestamp: run.created_at,
      latencyMs: run.latency_ms,
      errorMessage: run.error_message || undefined,
    }));

    return {
      targetId: target.id,
      targetName: target.name,
      targetType: target.type,
      currentStatus,
      latestCheck: latestRun
        ? {
            status: latestRun.status,
            timestamp: latestRun.created_at,
            latencyMs: latestRun.latency_ms,
            errorMessage: latestRun.error_message || undefined,
          }
        : undefined,
      healthHistory,
      stats1h,
      stats24h,
    };
  }

  /**
   * 获取全局汇总
   */
  async getGlobalSummary(useCache = true): Promise<GlobalSummary> {
    const now = Date.now();

    // 检查缓存
    if (useCache && this.globalCache.data && now - this.globalCache.timestamp < this.CACHE_TTL_MS) {
      return this.globalCache.data;
    }

    const summaries = await this.getAllTargetsSummary(useCache);

    const totalTargets = summaries.length;
    const activeTargets = summaries.filter(s => s.latestCheck).length;
    const healthyTargets = summaries.filter(s => s.currentStatus === 'ok').length;
    const degradedTargets = summaries.filter(s => s.currentStatus === 'degraded').length;
    const downTargets = summaries.filter(s => s.currentStatus === 'down').length;

    // 计算整体24小时可用率（所有目标的平均）
    const overall24hAvailability =
      summaries.length > 0
        ? summaries.reduce((sum, s) => sum + s.stats24h.availability, 0) / summaries.length
        : 0;

    // 计算整体24小时平均延迟
    const overall24hAvgLatency =
      summaries.length > 0
        ? summaries.reduce((sum, s) => sum + s.stats24h.avgLatency, 0) / summaries.length
        : 0;

    const globalSummary: GlobalSummary = {
      totalTargets,
      activeTargets,
      healthyTargets,
      degradedTargets,
      downTargets,
      overall24hAvailability: Math.round(overall24hAvailability * 100) / 100,
      overall24hAvgLatency: Math.round(overall24hAvgLatency),
    };

    // 更新缓存
    this.globalCache.data = globalSummary;
    this.globalCache.timestamp = now;

    return globalSummary;
  }

  /**
   * 获取目标的详细检查历史
   */
  async getTargetRuns(targetId: string, options?: { limit?: number; window?: string }) {
    const limit = options?.limit || 50;
    const window = options?.window || '24h';

    let startTime = 0;
    if (window === '1h') {
      startTime = Date.now() - 60 * 60 * 1000;
    } else if (window === '24h') {
      startTime = Date.now() - 24 * 60 * 60 * 1000;
    } else if (window === '7d') {
      startTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
    }

    const runs = await healthRunDb.getByTargetId(targetId, limit);

    if (startTime > 0) {
      return runs.filter(r => r.created_at >= startTime);
    }

    return runs;
  }

  /**
   * 计算统计数据
   */
  private calculateStats(runs: any[]) {
    if (runs.length === 0) {
      return {
        totalChecks: 0,
        successCount: 0,
        errorCount: 0,
        availability: 0,
        avgLatency: 0,
        p50Latency: 0,
        p95Latency: 0,
      };
    }

    const successCount = runs.filter(r => r.status === 'success').length;
    const errorCount = runs.filter(r => r.status === 'error').length;
    const availability = (successCount / runs.length) * 100;

    const latencies = runs.map(r => r.latency_ms);
    const avgLatency = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
    const p50Latency = calculatePercentiles(latencies, 50);
    const p95Latency = calculatePercentiles(latencies, 95);

    return {
      totalChecks: runs.length,
      successCount,
      errorCount,
      availability: Math.round(availability * 100) / 100,
      avgLatency: Math.round(avgLatency),
      p50Latency,
      p95Latency,
    };
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.summaryCache.data = null;
    this.summaryCache.timestamp = 0;
    this.globalCache.data = null;
    this.globalCache.timestamp = 0;
  }
}

export const healthAggregatorService = new HealthAggregatorService();
