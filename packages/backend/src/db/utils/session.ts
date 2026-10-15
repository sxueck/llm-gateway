/**
 * 会话口径常量。
 *
 * 网关不再自己判定“会话边界”，只在两个入口复用同一个间隔阈值：
 * Agent 归因的 session 分段（services/agent-metrics.ts）与请求日志的
 * 会话回溯（db/repositories/api-request.repository.ts）。两处必须同值，
 * 否则同一个客户端在两个页面会被切成不同的会话。
 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * 启发式回溯的单次扫描上限：无显式 session_id 时按 (虚拟密钥, IP) 取锚点
 * 前后窗口内的明细。窗口/上限之外的超长会话会被截断并在响应里标记 truncated，
 * 不做补扫——精确口径依赖客户端携带 session_id。
 */
export const SESSION_SCAN_LIMIT = 1000;

/** 返回给前端的会话请求条数上限。 */
export const SESSION_MAX_REQUESTS = 500;

/** 启发式回溯向锚点之前扫描的最大跨度。 */
export const SESSION_HEURISTIC_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** 启发式回溯向锚点之后扫描的最大跨度（用于区分同一 IP 的并发会话）。 */
export const SESSION_HEURISTIC_LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
