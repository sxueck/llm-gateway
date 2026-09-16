import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { agentRunMonitoringRepository } from "../../db/repositories/agent-search.repository.js";
import type { AgentSearchRun } from "../../db/types.js";

const VALID_STATUSES: readonly AgentSearchRun["status"][] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
  "expired",
];

function sendError(
  reply: FastifyReply,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(400).send({
    error: { message, type: "invalid_request_error", param: null, code },
  });
}

export async function agentMonitoringRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;

    const limitRaw = query.limit ?? "50";
    const limit = Number(limitRaw);
    if (
      !Number.isInteger(limit) ||
      String(limit) !== limitRaw ||
      limit < 1 ||
      limit > 100
    ) {
      return sendError(
        reply,
        "invalid_limit",
        "limit must be an integer between 1 and 100",
      );
    }

    const offsetRaw = query.offset ?? "0";
    const offset = Number(offsetRaw);
    if (
      !Number.isInteger(offset) ||
      String(offset) !== offsetRaw ||
      offset < 0
    ) {
      return sendError(
        reply,
        "invalid_offset",
        "offset must be a non-negative integer",
      );
    }

    let status: AgentSearchRun["status"] | undefined;
    if (query.status !== undefined) {
      if (!VALID_STATUSES.includes(query.status as AgentSearchRun["status"])) {
        return sendError(
          reply,
          "invalid_status",
          `status must be one of: ${VALID_STATUSES.join(", ")}`,
        );
      }
      status = query.status as AgentSearchRun["status"];
    }

    if (query.status !== undefined && query.activeOnly !== undefined) {
      return sendError(
        reply,
        "invalid_request",
        "status and activeOnly cannot be used together",
      );
    }

    let activeOnly: boolean | undefined;
    if (query.activeOnly !== undefined) {
      if (query.activeOnly === "true") activeOnly = true;
      else if (query.activeOnly === "false") activeOnly = false;
      else {
        return sendError(
          reply,
          "invalid_active_only",
          "activeOnly must be 'true' or 'false'",
        );
      }
    }

    const { items, summary } = await agentRunMonitoringRepository.list({
      status,
      activeOnly,
      limit,
      offset,
    });

    return { summary, items, limit, offset };
  });
}
