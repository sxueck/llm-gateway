import type { FastifyInstance, FastifyReply } from "fastify";
import {
  getCodingAgentOverview,
  getAgentSessions,
  getWorkerRunOverview,
  isAgentMetricsPeriod,
  resolveAgentWindow,
} from "../services/agent-metrics.js";
import { AGENT_KEYS } from "../services/agent-classifier.js";

interface AgentMetricsQueryParams {
  period?: string;
  endTime?: string;
}

const CLOCK_SKEW_MS = 60_000;

/** period / endTime 校验与 routes/ops-metrics.ts 的 parseWindowAndFilters 同口径。 */
function parseWindow(
  query: AgentMetricsQueryParams,
): { period: "24h" | "7d" | "30d"; endTime?: number } | { error: string } {
  if (!isAgentMetricsPeriod(query.period)) {
    return { error: "period must be one of 24h, 7d, 30d" };
  }
  let endTime: number | undefined;
  if (query.endTime) {
    endTime = Number(query.endTime);
    if (!Number.isFinite(endTime) || endTime <= 0) {
      return { error: "endTime must be a positive millisecond timestamp" };
    }
    if (endTime > Date.now() + CLOCK_SKEW_MS) {
      return { error: "endTime must not be in the future" };
    }
  }
  return { period: query.period, endTime };
}

const VALID_AGENT_KEYS = new Set<string>(AGENT_KEYS);

export async function agentMetricsRoutes(fastify: FastifyInstance) {
  // 与 /api/admin/agent-runs 相同的 admin 鉴权边界。
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/agent-metrics/coding-agents", async (request, reply) => {
    const parsed = parseWindow(request.query as AgentMetricsQueryParams);
    if ("error" in parsed) {
      return reply400(reply, parsed.error);
    }
    // 客户端每次刷新固定一次 endTime，使同批卡片采样同一时刻。
    return getCodingAgentOverview(resolveAgentWindow(parsed.period, parsed.endTime));
  });

  fastify.get(
    "/agent-metrics/coding-agents/:key/sessions",
    async (request, reply) => {
      const parsed = parseWindow(request.query as AgentMetricsQueryParams);
      if ("error" in parsed) {
        return reply400(reply, parsed.error);
      }
      const { key } = request.params as { key: string };
      if (!VALID_AGENT_KEYS.has(key)) {
        return reply400(reply, "key must be a known agent key");
      }
      return getAgentSessions(key, resolveAgentWindow(parsed.period, parsed.endTime));
    },
  );

  fastify.get("/agent-metrics/worker-runs", async (request, reply) => {
    const parsed = parseWindow(request.query as AgentMetricsQueryParams);
    if ("error" in parsed) {
      return reply400(reply, parsed.error);
    }
    return getWorkerRunOverview(resolveAgentWindow(parsed.period, parsed.endTime));
  });
}

function reply400(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: "invalid_agent_metrics_query",
    },
  });
}
