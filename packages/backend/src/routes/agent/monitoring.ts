import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  TERMINAL_RUN_EVENT_TYPES,
  TERMINAL_RUN_STATUSES,
} from "@llm-gateway/shared";
import { agentSearchRunDb } from "../../db/index.js";
import {
  agentRunMonitoringRepository,
  agentSearchRunEventRepository,
  agentSearchUsageRepository,
} from "../../db/repositories/agent-search.repository.js";
import { runEventHub } from "../../agent/run/run-events.js";
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

  // 只读详情：与列表同一隐私边界 —— 绝不返回 query/result 密文、service token、
  // 加密字段；事件 payload 本身只含 turn/token/tool 元数据（internal.ts 白名单）。
  fastify.get("/:id", (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    return getRunDetail(reply, id);
  });

  // admin 实时事件流：与用户侧 /api/agent/searches/:id/events 同一 replay+订阅
  // 语义，但走 JWT 鉴权（monitoring 路由级 onRequest hook）。前端用 fetch 流式
  // 读取（EventSource 无法携带 Authorization header）。
  fastify.get("/:id/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const run = await agentSearchRunDb.getById(id);
    if (!run) {
      return reply.code(404).send({
        error: {
          message: "agent run not found",
          type: "invalid_request_error",
          param: null,
          code: "not_found",
        },
      });
    }

    const query = request.query as { after?: string };
    const lastEventId =
      Number(request.headers["last-event-id"] || query.after || 0) || 0;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let stream: ReturnType<typeof runEventHub.openStream> | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      stream?.unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.end();
    };

    // close 监听须先于订阅建立，否则重放期间断开会泄漏订阅与心跳
    request.raw.on("close", close);

    stream = runEventHub.openStream(run.id, lastEventId, (event) => {
      reply.raw.write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
          run_id: run.id,
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          created_at: event.created_at,
        })}\n\n`,
      );
      if (
        (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(event.type)
      ) {
        setTimeout(close, 50);
      }
    });
    const sawTerminal = await stream.done;
    const statusTerminal = (
      TERMINAL_RUN_STATUSES as readonly string[]
    ).includes(run.status);
    if (sawTerminal || statusTerminal) {
      close();
      return reply;
    }

    heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": ping\n\n");
    }, 15000);

    return reply;
  });
}

// 单次全量回放上限：事件表按 (run_id, seq) 追加，正常 run 远低于此值；
// 超限只可能来自异常长的 run，截断标志让 UI 提示而非静默丢数据。
const MAX_EVENT_REPLAY = 2000;

async function getRunDetail(reply: FastifyReply, id: string) {
  const run = await agentSearchRunDb.getById(id);
  if (!run) {
    return reply.code(404).send({
      error: {
        message: "agent run not found",
        type: "invalid_request_error",
        param: null,
        code: "not_found",
      },
    });
  }

  const [usage, eventRows] = await Promise.all([
    agentSearchUsageRepository.getByRunId(id),
    agentSearchRunEventRepository.listAfter(id, 0, MAX_EVENT_REPLAY),
  ]);

  const startedAt = run.started_at === null ? null : Number(run.started_at);
  const completedAt =
    run.completed_at === null ? null : Number(run.completed_at);

  return {
    run: {
      id: run.id,
      user_id: run.user_id,
      virtual_key_id: run.virtual_key_id,
      plugin: {
        id: run.plugin_id,
        version: run.plugin_version,
        digest: run.plugin_digest,
      },
      source: {
        type: run.source_type,
        snapshot_id: run.snapshot_id,
        requested_ref: run.requested_ref,
        commit: run.resolved_commit,
      },
      model_profile: run.model_profile,
      status: run.status,
      created_at: Number(run.created_at),
      started_at: startedAt,
      completed_at: completedAt,
      expires_at: Number(run.expires_at),
      cancellation_requested_at:
        run.cancellation_requested_at === null
          ? null
          : Number(run.cancellation_requested_at),
      duration_ms:
        startedAt !== null ? (completedAt ?? Date.now()) - startedAt : null,
      error: run.error_code
        ? { code: run.error_code, message: run.error_message }
        : null,
      usage: usage
        ? {
            turn_count: Number(usage.turn_count),
            tool_call_count: Number(usage.tool_call_count),
            input_tokens: Number(usage.input_tokens),
            output_tokens: Number(usage.output_tokens),
            cost: Number(usage.cost),
          }
        : null,
    },
    events: eventRows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = row.payload_json
          ? (JSON.parse(row.payload_json) as Record<string, unknown>)
          : {};
      } catch {
        payload = { _raw: row.payload_json };
      }
      return {
        seq: row.seq,
        type: row.type,
        payload,
        created_at: Number(row.created_at),
      };
    }),
    events_truncated: eventRows.length >= MAX_EVENT_REPLAY,
  };
}
