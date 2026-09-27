import {
  agentMetricsRepository,
  type AgentSessionDetailRow,
  type RunErrorCodeRow,
  type RunModelProfileRow,
  type RunPluginRow,
  type RunStatusRow,
  type RunTotals,
  type RunTrendRow,
} from "../db/repositories/agent-metrics.repository.js";
import { costMappingService } from "./cost-mapping.js";
import { classifyAgent, type AgentCategory } from "./agent-classifier.js";
import { generateShanghaiDayBuckets } from "../db/utils/time-buckets.js";

/**
 * 「Agent 使用统计」服务层：UA 归并、成本估算（复用 cost-mapping 的单一
 * 口径）、session 分段与 worker run 汇总组装。
 *
 * 窗口语义照抄 ops-metrics.resolveWindow：endTime 默认 Date.now()，
 * startTime = endTime - 周期时长。token 口径与仓库明细聚合一致
 * （prompt/completion/total 仅 cache_hit=0 行，cached_tokens 全量行）。
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type AgentMetricsPeriod = "24h" | "7d" | "30d";

const PERIOD_MS: Record<AgentMetricsPeriod, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export function isAgentMetricsPeriod(value: unknown): value is AgentMetricsPeriod {
  return value === "24h" || value === "7d" || value === "30d";
}

export interface AgentMetricsWindow {
  period: AgentMetricsPeriod;
  startTime: number;
  endTime: number;
}

export function resolveAgentWindow(
  period: AgentMetricsPeriod,
  endTime: number = Date.now(),
): AgentMetricsWindow {
  return { period, endTime, startTime: endTime - PERIOD_MS[period] };
}

export type CostCoverage = "full" | "partial" | "none";

export interface CodingAgentSummary {
  key: string;
  label: string;
  category: AgentCategory;
  requests: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  lastActiveAt: number | null;
  /** 任一 model 无价格时为 null（避免报偏低的合计），并用 costCoverage 标注。 */
  estimatedCost: number | null;
  costCoverage: CostCoverage;
  /** 该归类下的原始 UA 样本（不含空 UA），用于排查归类是否合理。 */
  userAgents: string[];
}

export interface CodingAgentTotals {
  requests: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  agentCount: number;
  /** classifyAgent 归为 unknown（含空 UA / disable_logging 抑制行）的合计。 */
  unattributed: {
    requests: number;
    successCount: number;
    failureCount: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
  };
}

export interface CodingAgentOverview {
  window: { startTime: number; endTime: number; timezone: "Asia/Shanghai" };
  updatedAt: number;
  costCoverage: CostCoverage;
  agents: CodingAgentSummary[];
  totals: CodingAgentTotals;
}

export interface AgentSessionSummary {
  sessionId: string;
  startedAt: number;
  lastAt: number;
  durationMs: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  models: string[];
  ip: string | null;
  virtualKeyId: string | null;
}

export interface AgentSessionsResult {
  window: { startTime: number; endTime: number; timezone: "Asia/Shanghai" };
  updatedAt: number;
  key: string;
  sessions: AgentSessionSummary[];
}

export interface WorkerRunOverview {
  window: { startTime: number; endTime: number; timezone: "Asia/Shanghai" };
  updatedAt: number;
  granularity: "hour" | "day";
  totals: RunTotals;
  byStatus: RunStatusRow[];
  byPlugin: RunPluginRow[];
  byModelProfile: RunModelProfileRow[];
  errorCodes: RunErrorCodeRow[];
  trend: RunTrendRow[];
}

/**
 * estimateUsageCost 内部有 DB 读，逐行调用会放大查询量。其对 token 用量
 * 是线性的（单价 × 数量求和，见 cost-mapping.ts），故每个 distinct model
 * 只探测 3 次（输入/输出/缓存各 1 token）得到单价，再在内存里按量求和，
 * 结果与逐行调用完全一致。任一探测返回 null 即该模型无价格（与直接调用
 * 返回 null 等价）。
 */
interface ModelUnitCost {
  input: number;
  output: number;
  cached: number;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

async function buildModelUnitCosts(
  models: Iterable<string>,
): Promise<Map<string, ModelUnitCost | null>> {
  const result = new Map<string, ModelUnitCost | null>();
  for (const model of models) {
    if (result.has(model)) continue;
    const input = await costMappingService.estimateUsageCost(model, {
      promptTokens: 1,
      completionTokens: 0,
      cachedTokens: 0,
    });
    if (input === null) {
      result.set(model, null);
      continue;
    }
    const output = await costMappingService.estimateUsageCost(model, {
      promptTokens: 0,
      completionTokens: 1,
      cachedTokens: 0,
    });
    const cached = await costMappingService.estimateUsageCost(model, {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 1,
    });
    result.set(model, {
      input,
      output: output ?? 0,
      cached: cached ?? input,
    });
  }
  return result;
}

function computeCost(unit: ModelUnitCost | null, usage: TokenUsage): number | null {
  if (unit === null) return null;
  return (
    usage.promptTokens * unit.input +
    usage.completionTokens * unit.output +
    usage.cachedTokens * unit.cached
  );
}

interface AgentAccumulator {
  identity: { key: string; label: string; category: AgentCategory };
  requests: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  lastActiveAt: number | null;
  userAgents: Set<string>;
  /** model（null 记 ""）→ 该 agent 下的 token 合并结果。 */
  modelUsage: Map<string, TokenUsage>;
}

export async function getCodingAgentOverview(
  window: AgentMetricsWindow,
): Promise<CodingAgentOverview> {
  const rows = await agentMetricsRepository.getCodingAgentRows({
    startTime: window.startTime,
    endTime: window.endTime,
  });

  const agents = new Map<string, AgentAccumulator>();
  for (const row of rows) {
    const identity = classifyAgent(row.userAgent);
    let acc = agents.get(identity.key);
    if (!acc) {
      acc = {
        identity,
        requests: 0,
        successCount: 0,
        failureCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        lastActiveAt: null,
        userAgents: new Set<string>(),
        modelUsage: new Map<string, TokenUsage>(),
      };
      agents.set(identity.key, acc);
    }
    acc.requests += row.requests;
    acc.successCount += row.successCount;
    acc.failureCount += row.failureCount;
    acc.promptTokens += row.promptTokens;
    acc.completionTokens += row.completionTokens;
    acc.cachedTokens += row.cachedTokens;
    acc.totalTokens += row.totalTokens;
    if (row.lastActiveAt !== null) {
      acc.lastActiveAt = Math.max(acc.lastActiveAt ?? 0, row.lastActiveAt);
    }
    if (row.userAgent) acc.userAgents.add(row.userAgent);
    const modelKey = row.model ?? "";
    const usage = acc.modelUsage.get(modelKey) ?? {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    };
    usage.promptTokens += row.promptTokens;
    usage.completionTokens += row.completionTokens;
    usage.cachedTokens += row.cachedTokens;
    acc.modelUsage.set(modelKey, usage);
  }

  // 同一 model 只探测一次单价，所有 agent 共享。空 model（api_requests.model 为 NULL）
  // 不参与探测：estimateUsageCost("") 必定解析不到定价，探一次只是白发一次 DB 读。
  const distinctModels = new Set<string>();
  for (const acc of agents.values()) {
    for (const modelKey of acc.modelUsage.keys()) {
      if (modelKey !== "") distinctModels.add(modelKey);
    }
  }
  const unitCosts = await buildModelUnitCosts(distinctModels);

  const summaries: CodingAgentSummary[] = [];
  const coverages: CostCoverage[] = [];
  for (const acc of agents.values()) {
    let cost = 0;
    let priced = 0;
    let unpriced = 0;
    for (const [modelKey, usage] of acc.modelUsage) {
      // model 为 NULL 的行永远无价格（estimateUsageCost(null) → null）。
      const modelCost =
        modelKey === ""
          ? null
          : computeCost(unitCosts.get(modelKey) ?? null, usage);
      if (modelCost === null) unpriced += 1;
      else {
        priced += 1;
        cost += modelCost;
      }
    }
    const coverage: CostCoverage =
      unpriced === 0 ? "full" : priced === 0 ? "none" : "partial";
    coverages.push(coverage);
    summaries.push({
      key: acc.identity.key,
      label: acc.identity.label,
      category: acc.identity.category,
      requests: acc.requests,
      successCount: acc.successCount,
      failureCount: acc.failureCount,
      promptTokens: acc.promptTokens,
      completionTokens: acc.completionTokens,
      cachedTokens: acc.cachedTokens,
      totalTokens: acc.totalTokens,
      lastActiveAt: acc.lastActiveAt,
      estimatedCost: coverage === "full" ? cost : null,
      costCoverage: coverage,
      userAgents: [...acc.userAgents],
    });
  }
  summaries.sort((a, b) => b.requests - a.requests);

  const totals: CodingAgentTotals = {
    requests: 0,
    successCount: 0,
    failureCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    agentCount: summaries.length,
    unattributed: {
      requests: 0,
      successCount: 0,
      failureCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    },
  };
  for (const summary of summaries) {
    totals.requests += summary.requests;
    totals.successCount += summary.successCount;
    totals.failureCount += summary.failureCount;
    totals.promptTokens += summary.promptTokens;
    totals.completionTokens += summary.completionTokens;
    totals.cachedTokens += summary.cachedTokens;
    totals.totalTokens += summary.totalTokens;
    // 任一 agent 成本未知时总额不可信，整体置 null 而非报偏低值。
    if (summary.estimatedCost === null) {
      totals.estimatedCost = null;
    } else if (totals.estimatedCost !== null) {
      totals.estimatedCost += summary.estimatedCost;
    }
    if (summary.key === "unknown") {
      totals.unattributed = {
        requests: summary.requests,
        successCount: summary.successCount,
        failureCount: summary.failureCount,
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        cachedTokens: summary.cachedTokens,
        totalTokens: summary.totalTokens,
      };
    }
  }

  // 整体口径：所有 agent 覆盖率一致就沿用该值，混合才算 partial。
  let overallCoverage: CostCoverage = "full";
  if (coverages.length > 0) {
    const first = coverages[0];
    overallCoverage = coverages.every((c) => c === first) ? first : "partial";
  }

  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    costCoverage: overallCoverage,
    agents: summaries,
    totals,
  };
}

/** 会话间隔阈值：取自 llmgateway.io 对「一次使用会话」的定义（30 分钟无活动即切分）。 */
const SESSION_GAP_MS = 30 * 60 * 1000;
/** 单次明细拉取上限（最新优先），限制 session 重建的查询成本。 */
const SESSION_DETAIL_LIMIT = 2000;
const MAX_SESSIONS = 100;

interface SessionBuild {
  sessionId: string;
  startedAt: number;
  lastAt: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  ip: string | null;
  virtualKeyId: string | null;
  modelUsage: Map<string, TokenUsage>;
}

export async function getAgentSessions(
  agentKey: string,
  window: AgentMetricsWindow,
): Promise<AgentSessionsResult> {
  // 复用聚合行拿该 key 下全部 UA 字符串（空 UA 归 unknown，天然不会进入
  // 其他 key 的明细查询）。
  const rows = await agentMetricsRepository.getCodingAgentRows({
    startTime: window.startTime,
    endTime: window.endTime,
  });
  const userAgents = [
    ...new Set(
      rows
        .map((row) => row.userAgent)
        .filter((ua): ua is string => ua !== null)
        .filter((ua) => classifyAgent(ua).key === agentKey),
    ),
  ];
  const detail: AgentSessionDetailRow[] =
    userAgents.length === 0
      ? []
      : await agentMetricsRepository.getAgentSessions(
          { startTime: window.startTime, endTime: window.endTime },
          userAgents,
          SESSION_DETAIL_LIMIT,
        );

  // session 分段：按 (ip, virtual_key_id) 分组，组内按 created_at 升序，
  // 相邻间隔 > SESSION_GAP_MS 即切一个新 session。
  const groups = new Map<string, AgentSessionDetailRow[]>();
  for (const row of detail) {
    const groupKey = `${row.ip ?? ""}|${row.virtualKeyId ?? ""}`;
    const list = groups.get(groupKey);
    if (list) list.push(row);
    else groups.set(groupKey, [row]);
  }

  const sessions: SessionBuild[] = [];
  for (const rowset of groups.values()) {
    rowset.sort((a, b) => a.createdAt - b.createdAt);
    let current: SessionBuild | null = null;
    for (const row of rowset) {
      if (current === null || row.createdAt - current.lastAt > SESSION_GAP_MS) {
        current = {
          sessionId: row.id,
          startedAt: row.createdAt,
          lastAt: row.createdAt,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          ip: row.ip,
          virtualKeyId: row.virtualKeyId,
          modelUsage: new Map<string, TokenUsage>(),
        };
        sessions.push(current);
      }
      current.lastAt = row.createdAt;
      current.requests += 1;
      current.promptTokens += row.promptTokens;
      current.completionTokens += row.completionTokens;
      const modelKey = row.model ?? "";
      const usage = current.modelUsage.get(modelKey) ?? {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
      };
      usage.promptTokens += row.promptTokens;
      usage.completionTokens += row.completionTokens;
      usage.cachedTokens += row.cachedTokens;
      current.modelUsage.set(modelKey, usage);
    }
  }

  const distinctModels = new Set<string>();
  for (const session of sessions) {
    for (const modelKey of session.modelUsage.keys()) distinctModels.add(modelKey);
  }
  const unitCosts = await buildModelUnitCosts(distinctModels);

  const summaries: AgentSessionSummary[] = sessions.map((session) => {
    let cost = 0;
    let unpriced = 0;
    for (const [modelKey, usage] of session.modelUsage) {
      const modelCost =
        modelKey === ""
          ? null
          : computeCost(unitCosts.get(modelKey) ?? null, usage);
      if (modelCost === null) unpriced += 1;
      else cost += modelCost;
    }
    return {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      lastAt: session.lastAt,
      durationMs: session.lastAt - session.startedAt,
      requests: session.requests,
      promptTokens: session.promptTokens,
      completionTokens: session.completionTokens,
      totalTokens: session.promptTokens + session.completionTokens,
      estimatedCost: unpriced > 0 ? null : cost,
      models: [...session.modelUsage.keys()]
        .filter((modelKey) => modelKey !== "")
        .sort(),
      ip: session.ip,
      virtualKeyId: session.virtualKeyId,
    };
  });
  summaries.sort((a, b) => b.lastAt - a.lastAt);

  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    key: agentKey,
    sessions: summaries.slice(0, MAX_SESSIONS),
  };
}

export async function getWorkerRunOverview(
  window: AgentMetricsWindow,
): Promise<WorkerRunOverview> {
  const granularity: "hour" | "day" = window.period === "24h" ? "hour" : "day";
  const timeWindow = { startTime: window.startTime, endTime: window.endTime };
  const [totals, byStatus, byPlugin, byModelProfile, errorCodes, trendRows] =
    await Promise.all([
      agentMetricsRepository.getRunTotals(timeWindow),
      agentMetricsRepository.getRunBreakdownByStatus(timeWindow),
      agentMetricsRepository.getRunBreakdownByPlugin(timeWindow),
      agentMetricsRepository.getModelProfiles(timeWindow),
      agentMetricsRepository.getRunErrorCodes(timeWindow),
      agentMetricsRepository.getRunTrend(timeWindow, granularity),
    ]);

  // 补零桶，分桶口径与 ops-metrics.getOpsTrend 一致：小时桶对齐 UTC 整点，
  // 日桶对齐上海 0 点，保证图表 x 轴连续。
  const buckets: number[] = [];
  if (granularity === "hour") {
    for (
      let b = Math.floor(window.startTime / HOUR_MS) * HOUR_MS;
      b < window.endTime;
      b += HOUR_MS
    ) {
      buckets.push(b);
    }
  } else {
    for (const dayStart of generateShanghaiDayBuckets(
      window.startTime,
      window.endTime - 1,
    )) {
      if (dayStart < window.endTime) buckets.push(dayStart);
    }
  }
  const byBucket = new Map(trendRows.map((row) => [row.bucketStart, row]));
  const trend: RunTrendRow[] = buckets.map(
    (bucketStart) =>
      byBucket.get(bucketStart) ?? {
        bucketStart,
        runs: 0,
        completed: 0,
        failed: 0,
        tokens: 0,
        cost: 0,
      },
  );

  // 只输出匿名聚合结果，不携带 query 文本或任何用户可识别字段。
  return {
    window: {
      startTime: window.startTime,
      endTime: window.endTime,
      timezone: "Asia/Shanghai",
    },
    updatedAt: Date.now(),
    granularity,
    totals,
    byStatus,
    byPlugin,
    byModelProfile,
    errorCodes,
    trend,
  };
}
