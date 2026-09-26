import { healthTargetDb, healthRunDb } from '../db/index.js';
import type { HealthRun, HealthTarget } from '../db/types.js';

interface TargetSummary {
  targetId: string;
  targetName: string;
  displayTitle?: string;
  targetType: 'model' | 'virtual_model';
  checkIntervalSeconds: number;
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
  stats7d: {
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

function determineStatus(runs: HealthRun[], windowMs: number): 'ok' | 'degraded' | 'down' | 'unknown' {
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

  private summaryPromise: Promise<TargetSummary[]> | null = null;

  private readonly CACHE_TTL_MS = 15000; // 15秒缓存

  /**
   * 获取所有目标的汇总信息
   */
  async getAllTargetsSummary(useCache = true): Promise<TargetSummary[]> {
    const now = Date.now();

    if (useCache && this.summaryCache.data && now - this.summaryCache.timestamp < this.CACHE_TTL_MS) {
      return this.summaryCache.data;
    }

    if (useCache && this.summaryPromise) {
      return this.summaryPromise;
    }

    const load = this.loadAllTargetsSummary();
    if (!useCache) return load;

    this.summaryPromise = load;
    try {
      return await load;
    } finally {
      if (this.summaryPromise === load) {
        this.summaryPromise = null;
      }
    }
  }

  private async loadAllTargetsSummary(): Promise<TargetSummary[]> {
    const now = Date.now();
    const targets = await healthTargetDb.getEnabled();
    const targetIds = targets.map(target => target.id);
    const window24h = 24 * 60 * 60 * 1000;
    const window7d = 7 * 24 * 60 * 60 * 1000;

    const [runsByTarget, stats7dByTarget, recentRunsByTarget] = await Promise.all([
      healthRunDb.getByTargetsTimeWindow(targetIds, now - window24h, now),
      healthRunDb.getStatsByTargets(targetIds, now - window7d, now),
      healthRunDb.getRecentByTargets(targetIds, 100),
    ]);

    const summaries = targets.map(target =>
      this.buildTargetSummary(
        target,
        runsByTarget.get(target.id) || [],
        stats7dByTarget.get(target.id),
        recentRunsByTarget.get(target.id) || [],
        now,
      ),
    );

    this.summaryCache.data = summaries;
    this.summaryCache.timestamp = Date.now();
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
    const window24h = 24 * 60 * 60 * 1000;
    const window7d = 7 * 24 * 60 * 60 * 1000;
    const [runs24h, stats7dRaw, recentRuns] = await Promise.all([
      healthRunDb.getByTimeWindow(targetId, now - window24h, now),
      healthRunDb.getStats(targetId, now - window7d, now),
      healthRunDb.getByTargetId(targetId, 100),
    ]);

    return this.buildTargetSummary(target, runs24h, stats7dRaw, recentRuns, now);
  }

  private buildTargetSummary(
    target: HealthTarget,
    runs24h: HealthRun[],
    stats7dRaw: {
      totalChecks: number;
      successCount: number;
      errorCount: number;
      avgLatency: number;
    } | undefined,
    recentRuns: HealthRun[],
    now: number,
  ): TargetSummary {
    const window1h = 60 * 60 * 1000;
    const runs1h = runs24h.filter(r => r.created_at >= now - window1h);
    const raw = stats7dRaw || {
      totalChecks: 0,
      successCount: 0,
      errorCount: 0,
      avgLatency: 0,
    };
    const availability = raw.totalChecks > 0
      ? (raw.successCount / raw.totalChecks) * 100
      : 0;
    const stats7d = {
      totalChecks: raw.totalChecks,
      successCount: raw.successCount,
      errorCount: raw.errorCount,
      availability: Math.round(availability * 100) / 100,
      avgLatency: raw.avgLatency,
      p50Latency: 0,
      p95Latency: 0,
    };

    const stats1h = this.calculateStats(runs1h);
    const stats24h = this.calculateStats(runs24h);
    const latestRun = runs24h.length > 0 ? runs24h[runs24h.length - 1] : null;
    const currentStatus = determineStatus(runs1h, window1h);
    const healthHistory = recentRuns.map(run => ({
      status: run.status,
      timestamp: run.created_at,
      latencyMs: run.latency_ms,
      errorMessage: run.error_message || undefined,
    }));

    return {
      targetId: target.id,
      targetName: target.name,
      displayTitle: target.display_title || undefined,
      targetType: target.type,
      checkIntervalSeconds: target.check_interval_seconds,
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
      stats7d,
    };
  }

  /**
   * 获取全局汇总
   */
  async getGlobalSummary(useCache = true): Promise<GlobalSummary> {
    const now = Date.now();

    if (useCache && this.globalCache.data && now - this.globalCache.timestamp < this.CACHE_TTL_MS) {
      return this.globalCache.data;
    }

    const summaries = await this.getAllTargetsSummary(useCache);

    const totalTargets = summaries.length;
    const activeTargets = summaries.filter(s => s.latestCheck).length;
    const healthyTargets = summaries.filter(s => s.currentStatus === 'ok').length;
    const degradedTargets = summaries.filter(s => s.currentStatus === 'degraded').length;
    const downTargets = summaries.filter(s => s.currentStatus === 'down').length;

    const overall24hAvailability =
      summaries.length > 0
        ? summaries.reduce((sum, s) => sum + s.stats24h.availability, 0) / summaries.length
        : 0;

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

    this.globalCache.data = globalSummary;
    this.globalCache.timestamp = now;

    return globalSummary;
  }

  async getTargetRunsPage(
    targetId: string,
    options: { limit: number; offset: number; window?: string },
  ): Promise<{ runs: HealthRun[]; total: number }> {
    const window = options.window || '24h';
    const endTime = Date.now();
    let startTime = 0;
    if (window === '1h') {
      startTime = endTime - 60 * 60 * 1000;
    } else if (window === '24h') {
      startTime = endTime - 24 * 60 * 60 * 1000;
    } else if (window === '7d') {
      startTime = endTime - 7 * 24 * 60 * 60 * 1000;
    }

    const [runs, total] = await Promise.all([
      healthRunDb.getTargetPage(
        targetId,
        startTime,
        endTime,
        options.limit,
        options.offset,
      ),
      healthRunDb.countByTarget(targetId, startTime, endTime),
    ]);
    return { runs, total };
  }

  /**
   * 计算统计数据
   */
  private calculateStats(runs: HealthRun[]) {
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
