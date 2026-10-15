import { getDatabase } from "../connection.js";

/**
 * 「Agent 使用统计」聚合读。
 *
 * api_requests 侧口径与 ops-metrics.repository 的 DETAIL 段一致：
 * - disable_logging 密钥纳入聚合（敏感元数据写入侧已置空，其 user_agent
 *   为 NULL，归入 '__empty__' 组呈现为「未识别」而非被剔除）；
 * - prompt/completion/total tokens 仅统计 cache_hit = 0 的请求（缓存命中
 *   不重复计费），cached_tokens 统计全部行。
 *
 * agent_search_runs 侧 LEFT JOIN agent_search_usage（run_id 为主键，1:1，
 * 不会放大行数）；窗口统一 `>= ? AND < ?` 半开区间，与 ops-metrics.repository
 * 同一口径（闭区间会把恰好在 endTime 的行计进相邻两个窗口）。所有外部输入一律参数化。
 */

export interface AgentMetricsTimeWindow {
  startTime: number;
  endTime: number;
}

export interface CodingAgentModelRow {
  userAgent: string | null;
  model: string | null;
  requests: number;
  successCount: number;
  failureCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  lastActiveAt: number | null;
}

export interface AgentSessionDetailRow {
  id: string;
  ip: string | null;
  virtualKeyId: string | null;
  model: string | null;
  status: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheHit: number;
  createdAt: number;
  responseTimeMs: number | null;
}

export interface RunTotals {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  other: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  avgDurationMs: number | null;
}

export interface RunPluginRow {
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
}

export interface RunStatusRow {
  status: string;
  runs: number;
  withErrorCode: number;
}

export interface RunErrorCodeRow {
  errorCode: string;
  count: number;
}

export interface RunTrendRow {
  bucketStart: number;
  runs: number;
  completed: number;
  failed: number;
  tokens: number;
  cost: number;
}

export interface RunModelProfileRow {
  profile: string;
  runs: number;
  cost: number;
  tokens: number;
}

const EMPTY_UA_GROUP = "__empty__";

/**
 * 时区分桶表达式照抄 ops-metrics.repository：小时桶 floorMs=3600000,
 * offset=0；上海日桶 floorMs=86400000, offset=+8h（Asia/Shanghai）。
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 命名状态之外的终态（timed_out/budget_exceeded/expired）合并为 other。 */
const NAMED_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "running",
  "queued",
] as const;

const OTHER_STATUS_SQL = `SUM(CASE WHEN r.status NOT IN (${NAMED_RUN_STATUSES.map(
  () => "?",
).join(",")}) THEN 1 ELSE 0 END)`;

/** 只统计 started_at/completed_at 均非空且 completed_at >= started_at 的行。 */
const RUN_DURATION_SUM = `SUM(CASE
             WHEN r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
                  AND r.completed_at >= r.started_at
             THEN r.completed_at - r.started_at ELSE 0 END)`;
const RUN_DURATION_COUNT = `SUM(CASE
             WHEN r.started_at IS NOT NULL AND r.completed_at IS NOT NULL
                  AND r.completed_at >= r.started_at
             THEN 1 ELSE 0 END)`;
const AVG_DURATION_SQL = `CASE WHEN ${RUN_DURATION_COUNT} > 0
             THEN ${RUN_DURATION_SUM} / ${RUN_DURATION_COUNT} ELSE NULL END`;

/** 状态名通过参数占位符传入（见各方法的 params），绝不拼接进 SQL。 */
const RUN_STATUS_COUNT = "SUM(CASE WHEN r.status = ? THEN 1 ELSE 0 END)";

function num(value: unknown): number {
  return Number(value) || 0;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export const agentMetricsRepository = {
  /**
   * 按 (user_agent, model) 聚合 api_requests，供服务层归类 agent 并按
   * model 估算成本。空 UA 归入 '__empty__' 组（服务层转回 null）。
   * 与 ops-metrics 聚合一致：不排除 disable_logging 密钥。
   */
  async getCodingAgentRows(
    window: AgentMetricsTimeWindow,
  ): Promise<CodingAgentModelRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           COALESCE(NULLIF(ar.user_agent, ''), '${EMPTY_UA_GROUP}') AS user_agent,
           ar.model AS model,
           COUNT(*) AS requests,
           SUM(CASE WHEN ar.status = 'success' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN ar.status <> 'success' OR ar.status IS NULL THEN 1 ELSE 0 END) AS failure_count,
           SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.prompt_tokens, 0) ELSE 0 END) AS prompt_tokens,
           SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.completion_tokens, 0) ELSE 0 END) AS completion_tokens,
           SUM(COALESCE(ar.cached_tokens, 0)) AS cached_tokens,
           SUM(CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.total_tokens, 0) ELSE 0 END) AS total_tokens,
           MAX(ar.created_at) AS last_active_at
         FROM api_requests ar
         WHERE ar.created_at >= ? AND ar.created_at < ?
         GROUP BY COALESCE(NULLIF(ar.user_agent, ''), '${EMPTY_UA_GROUP}'), ar.model
         ORDER BY requests DESC
         LIMIT 2000`,
        [window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        userAgent:
          row.user_agent === EMPTY_UA_GROUP ? null : String(row.user_agent),
        model: row.model === null || row.model === undefined ? null : String(row.model),
        requests: num(row.requests),
        successCount: num(row.success_count),
        failureCount: num(row.failure_count),
        promptTokens: num(row.prompt_tokens),
        completionTokens: num(row.completion_tokens),
        cachedTokens: num(row.cached_tokens),
        totalTokens: num(row.total_tokens),
        lastActiveAt: nullableNum(row.last_active_at),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * 指定 UA 集合的明细行（最新在前），供服务层在 JS 里做 session 分段。
   * 返回 ip 等敏感明细，故沿用 api-request.repository 明细读的隐私边界：
   * 排除 disable_logging 密钥的行（其 UA 本就为 NULL，理论上不可能命中，
   * 条件是纵深防御）。
   */
  async getAgentSessions(
    window: AgentMetricsTimeWindow,
    userAgents: string[],
    limit: number = 500,
  ): Promise<AgentSessionDetailRow[]> {
    if (userAgents.length === 0) return [];
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const placeholders = userAgents.map(() => "?").join(", ");
      const [rows] = await conn.query(
        `SELECT
           ar.id,
           ar.ip,
           ar.virtual_key_id,
           ar.model,
           ar.status,
           CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.prompt_tokens, 0) ELSE 0 END AS prompt_tokens,
           CASE WHEN ar.cache_hit = 0 THEN COALESCE(ar.completion_tokens, 0) ELSE 0 END AS completion_tokens,
           COALESCE(ar.cached_tokens, 0) AS cached_tokens,
           COALESCE(ar.cache_hit, 0) AS cache_hit,
           ar.created_at,
           ar.response_time
         FROM api_requests ar
         LEFT JOIN virtual_keys vk ON ar.virtual_key_id = vk.id
         WHERE ar.created_at >= ? AND ar.created_at < ?
           AND ar.user_agent IN (${placeholders})
           AND (ar.virtual_key_id IS NULL OR vk.id IS NULL OR vk.disable_logging IS NULL OR vk.disable_logging = 0)
         ORDER BY ar.created_at DESC
         LIMIT ?`,
        [window.startTime, window.endTime, ...userAgents, limit],
      );
      return (rows as any[]).map((row) => ({
        id: String(row.id),
        ip: row.ip === null || row.ip === undefined ? null : String(row.ip),
        virtualKeyId:
          row.virtual_key_id === null || row.virtual_key_id === undefined
            ? null
            : String(row.virtual_key_id),
        model: row.model === null || row.model === undefined ? null : String(row.model),
        status: row.status === null || row.status === undefined ? "" : String(row.status),
        promptTokens: num(row.prompt_tokens),
        completionTokens: num(row.completion_tokens),
        cachedTokens: num(row.cached_tokens),
        cacheHit: num(row.cache_hit),
        createdAt: num(row.created_at),
        responseTimeMs: nullableNum(row.response_time),
      }));
    } finally {
      conn.release();
    }
  },

  /** run 总量/状态/用量汇总，全部在 SQL 内完成（含 avgDurationMs）。 */
  async getRunTotals(window: AgentMetricsTimeWindow): Promise<RunTotals> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           COUNT(*) AS runs,
           ${RUN_STATUS_COUNT} AS completed,
           ${RUN_STATUS_COUNT} AS failed,
           ${RUN_STATUS_COUNT} AS cancelled,
           ${RUN_STATUS_COUNT} AS running,
           ${RUN_STATUS_COUNT} AS queued,
           ${OTHER_STATUS_SQL} AS other,
           SUM(COALESCE(u.turn_count, 0)) AS turns,
           SUM(COALESCE(u.tool_call_count, 0)) AS tool_calls,
           SUM(COALESCE(u.input_tokens, 0)) AS input_tokens,
           SUM(COALESCE(u.output_tokens, 0)) AS output_tokens,
           SUM(COALESCE(u.cost, 0)) AS cost,
           ${AVG_DURATION_SQL} AS avg_duration_ms
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?`,
        [
          "completed",
          "failed",
          "cancelled",
          "running",
          "queued",
          ...NAMED_RUN_STATUSES,
          window.startTime,
          window.endTime,
        ],
      );
      const row = (rows as any[])[0] ?? {};
      return {
        runs: num(row.runs),
        completed: num(row.completed),
        failed: num(row.failed),
        cancelled: num(row.cancelled),
        running: num(row.running),
        queued: num(row.queued),
        other: num(row.other),
        turns: num(row.turns),
        toolCalls: num(row.tool_calls),
        inputTokens: num(row.input_tokens),
        outputTokens: num(row.output_tokens),
        cost: num(row.cost),
        avgDurationMs: nullableNum(row.avg_duration_ms),
      };
    } finally {
      conn.release();
    }
  },

  /** 按插件 (id, version) 拆分 run 汇总。 */
  async getRunBreakdownByPlugin(
    window: AgentMetricsTimeWindow,
  ): Promise<RunPluginRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           r.plugin_id,
           r.plugin_version,
           COUNT(*) AS runs,
           ${RUN_STATUS_COUNT} AS completed,
           ${RUN_STATUS_COUNT} AS failed,
           SUM(COALESCE(u.turn_count, 0)) AS turns,
           SUM(COALESCE(u.tool_call_count, 0)) AS tool_calls,
           SUM(COALESCE(u.input_tokens, 0)) AS input_tokens,
           SUM(COALESCE(u.output_tokens, 0)) AS output_tokens,
           SUM(COALESCE(u.cost, 0)) AS cost,
           ${AVG_DURATION_SQL} AS avg_duration_ms
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?
         GROUP BY r.plugin_id, r.plugin_version
         ORDER BY runs DESC`,
        ["completed", "failed", window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        pluginId: String(row.plugin_id ?? ""),
        version: String(row.plugin_version ?? ""),
        runs: num(row.runs),
        completed: num(row.completed),
        failed: num(row.failed),
        turns: num(row.turns),
        toolCalls: num(row.tool_calls),
        inputTokens: num(row.input_tokens),
        outputTokens: num(row.output_tokens),
        cost: num(row.cost),
        avgDurationMs: nullableNum(row.avg_duration_ms),
      }));
    } finally {
      conn.release();
    }
  },

  /** 按状态拆分，附 error_code 非空计数。 */
  async getRunBreakdownByStatus(
    window: AgentMetricsTimeWindow,
  ): Promise<RunStatusRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           r.status,
           COUNT(*) AS runs,
           SUM(CASE WHEN r.error_code IS NOT NULL AND r.error_code <> '' THEN 1 ELSE 0 END) AS with_error_code
         FROM agent_search_runs r
         WHERE r.created_at >= ? AND r.created_at < ?
         GROUP BY r.status
         ORDER BY runs DESC`,
        [window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        status: String(row.status ?? ""),
        runs: num(row.runs),
        withErrorCode: num(row.with_error_code),
      }));
    } finally {
      conn.release();
    }
  },

  /** Top 错误码（不用 GROUP_CONCAT，独立方法便于前端单列展示）。 */
  async getRunErrorCodes(
    window: AgentMetricsTimeWindow,
  ): Promise<RunErrorCodeRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT r.error_code, COUNT(*) AS cnt
         FROM agent_search_runs r
         WHERE r.created_at >= ? AND r.created_at < ?
           AND r.error_code IS NOT NULL AND r.error_code <> ''
         GROUP BY r.error_code
         ORDER BY cnt DESC
         LIMIT 10`,
        [window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        errorCode: String(row.error_code ?? ""),
        count: num(row.cnt),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * run 趋势分桶。分桶表达式与 ops-metrics.repository 相同
   * （FLOOR((ts + offset) / floorMs) * floorMs - offset）。
   */
  async getRunTrend(
    window: AgentMetricsTimeWindow,
    granularity: "hour" | "day",
  ): Promise<RunTrendRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const floorMs = granularity === "hour" ? HOUR_MS : DAY_MS;
      const offsetMs = granularity === "hour" ? 0 : SHANGHAI_OFFSET_MS;
      const bucketExpr = `FLOOR((r.created_at + ${offsetMs}) / ${floorMs}) * ${floorMs} - ${offsetMs}`;
      const [rows] = await conn.query(
        `SELECT
           ${bucketExpr} AS bucket_start,
           COUNT(*) AS runs,
           ${RUN_STATUS_COUNT} AS completed,
           ${RUN_STATUS_COUNT} AS failed,
           SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS tokens,
           SUM(COALESCE(u.cost, 0)) AS cost
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?
         GROUP BY ${bucketExpr}
         ORDER BY bucket_start`,
        ["completed", "failed", window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        bucketStart: num(row.bucket_start),
        runs: num(row.runs),
        completed: num(row.completed),
        failed: num(row.failed),
        tokens: num(row.tokens),
        cost: num(row.cost),
      }));
    } finally {
      conn.release();
    }
  },

  /** 按模型档位（model_profile）拆分 run 用量。 */
  async getModelProfiles(
    window: AgentMetricsTimeWindow,
  ): Promise<RunModelProfileRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT
           r.model_profile,
           COUNT(*) AS runs,
           SUM(COALESCE(u.cost, 0)) AS cost,
           SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS tokens
         FROM agent_search_runs r
         LEFT JOIN agent_search_usage u ON u.run_id = r.id
         WHERE r.created_at >= ? AND r.created_at < ?
         GROUP BY r.model_profile
         ORDER BY runs DESC`,
        [window.startTime, window.endTime],
      );
      return (rows as any[]).map((row) => ({
        profile: String(row.model_profile ?? ""),
        runs: num(row.runs),
        cost: num(row.cost),
        tokens: num(row.tokens),
      }));
    } finally {
      conn.release();
    }
  },
};
