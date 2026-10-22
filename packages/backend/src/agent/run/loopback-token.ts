import { randomBytes, timingSafeEqual } from 'node:crypto';

// /api/agent/internal（worker 模型通道）loopback 借道公开 /v1/chat/completions
// 管线的共享密钥：每进程随机、永不落盘。约束：仅限单进程部署——cluster
// fork 各进程各自铸币，跨进程 loopback 会回退为白名单解析。
const LOOPBACK_TOKEN = randomBytes(32).toString('hex');

export const AGENT_LOOPBACK_HEADER = 'x-agent-loopback';
export const AGENT_RUN_ID_HEADER = 'x-agent-run-id';

export function agentLoopbackToken(): string {
  return LOOPBACK_TOKEN;
}

/**
 * 从请求头提取 agent run 关联 ID。仅在 loopback token 有效时信任
 * x-agent-run-id：外部调用方无法伪造 run 关联（头部会被直接丢弃）。
 */
export function agentRunIdFromHeaders(headers: unknown): string | undefined {
  const record = headers as Record<string, unknown> | undefined;
  if (!record || !isValidAgentLoopbackToken(record[AGENT_LOOPBACK_HEADER])) {
    return undefined;
  }
  const value = record[AGENT_RUN_ID_HEADER];
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    return undefined;
  }
  return value;
}

/** 常数时间比较；长度不符直接判否（timingSafeEqual 对不等长度抛异常）。 */
export function isValidAgentLoopbackToken(header: unknown): boolean {
  if (typeof header !== 'string' || header.length !== LOOPBACK_TOKEN.length) {
    return false;
  }
  const a = Buffer.from(header);
  const b = Buffer.from(LOOPBACK_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
