import request from '@/utils/request';

export type AgentMetricsPeriod = '24h' | '7d' | '30d';

export type AgentCategory =
  | 'coding-agent'
  | 'sdk'
  | 'script'
  | 'browser'
  | 'worker'
  | 'unknown';

export type CostCoverage = 'full' | 'partial' | 'none';

export interface AgentMetricsWindowInfo {
  startTime: number;
  endTime: number;
  timezone: 'Asia/Shanghai';
}

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
  /** 任一模型无价格时为 null，避免报偏低的合计。 */
  estimatedCost: number | null;
  costCoverage: CostCoverage;
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

export interface CodingAgentOverviewResponse {
  window: AgentMetricsWindowInfo;
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

export interface AgentSessionsResponse {
  window: AgentMetricsWindowInfo;
  updatedAt: number;
  key: string;
  sessions: AgentSessionSummary[];
}

export interface WorkerRunTotals {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  /** timed_out / budget_exceeded / expired 合并计数。 */
  other: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  avgDurationMs: number | null;
}

export interface WorkerRunOverviewResponse {
  window: AgentMetricsWindowInfo;
  updatedAt: number;
  granularity: 'hour' | 'day';
  totals: WorkerRunTotals;
  byStatus: Array<{ status: string; runs: number; withErrorCode: number }>;
  byPlugin: Array<{
    pluginId: string;
    version: string;
    runs: number;
    completed: number;
    failed: number;
    turns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    avgDurationMs: number | null;
  }>;
  byModelProfile: Array<{ profile: string; runs: number; cost: number; tokens: number }>;
  errorCodes: Array<{ errorCode: string; count: number }>;
  trend: Array<{
    bucketStart: number;
    runs: number;
    completed: number;
    failed: number;
    tokens: number;
    cost: number;
  }>;
}

const BASE = '/admin/agent-metrics';

// undefined 参数由 request 层丢弃；endTime 由前端在单次刷新内固定，
// 使同一批卡片采样到同一时刻（与 ops-metrics 的口径一致）。
function toParams(query: { period: AgentMetricsPeriod; endTime?: number }) {
  return { period: query.period, endTime: query.endTime };
}

export const agentMetricsApi = {
  getCodingAgents(query: { period: AgentMetricsPeriod; endTime?: number }): Promise<CodingAgentOverviewResponse> {
    return request.get(`${BASE}/coding-agents`, { params: toParams(query) });
  },

  getAgentSessions(
    key: string,
    query: { period: AgentMetricsPeriod; endTime?: number },
  ): Promise<AgentSessionsResponse> {
    return request.get(`${BASE}/coding-agents/${encodeURIComponent(key)}/sessions`, {
      params: toParams(query),
    });
  },

  getWorkerRuns(query: { period: AgentMetricsPeriod; endTime?: number }): Promise<WorkerRunOverviewResponse> {
    return request.get(`${BASE}/worker-runs`, { params: toParams(query) });
  },
};
