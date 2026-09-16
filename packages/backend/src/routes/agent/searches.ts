import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createSearchRunRequestSchema,
  TERMINAL_RUN_EVENT_TYPES,
  TERMINAL_RUN_STATUSES,
} from "@llm-gateway/shared";
import {
  authenticateVirtualKey,
  extractVirtualKeyAuthHeader,
} from "../proxy/auth.js";
import type { VirtualKeyAuthResult } from "../proxy/auth.js";
import { agentSearchRunDb } from "../../db/index.js";
import {
  RunError,
  getOwnedRun,
  getRunUsage,
  persistNewRun,
  readRunResult,
  validateRunInputs,
} from "../../agent/run/run.service.js";
import {
  runEventHub,
  type RunStreamHandle,
} from "../../agent/run/run-events.js";
import { searchRunScheduler } from "../../agent/run/scheduler.js";

const RUN_ERROR_STATUS: Record<string, number> = {
  unknown_plugin: 400,
  plugin_revoked: 403,
  snapshot_not_ready: 409,
  snapshot_expired: 410,
  model_profile_not_configured: 400,
  model_profile_override_forbidden: 403,
  not_found: 404,
  invalid_state: 409,
};

const MAX_QUEUED_RUNS = 200;

function sendRunError(reply: FastifyReply, e: unknown) {
  if (e instanceof RunError) {
    const status = RUN_ERROR_STATUS[e.opError.code] ?? 400;
    return reply.code(status).send({
      error: {
        message: e.opError.message,
        type: "invalid_request_error",
        param: null,
        code: e.opError.code,
      },
    });
  }
  throw e;
}

async function requireVirtualKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<VirtualKeyAuthResult | null> {
  const auth = await authenticateVirtualKey(
    extractVirtualKeyAuthHeader(request.headers),
  );
  if ("error" in auth) {
    reply.code(auth.error.code).send(auth.error.body);
    return null;
  }
  return auth;
}

export async function agentSearchRoutes(fastify: FastifyInstance) {
  fastify.post("/", async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const parsed = createSearchRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      });
    }
    if (searchRunScheduler.queueDepth() >= MAX_QUEUED_RUNS) {
      return reply.code(429).send({
        error: {
          message: "too many queued search runs",
          type: "rate_limit_error",
          param: null,
          code: "queue_full",
        },
      });
    }

    const principal = { virtualKeyId: auth.virtualKey.id };
    try {
      const { plugin, profile } = await validateRunInputs(
        principal,
        parsed.data,
      );
      const { run, serviceToken } = await persistNewRun({
        principal,
        body: parsed.data,
        plugin,
        profile,
      });
      await runEventHub.append(run.id, "run.queued", {
        plugin: `${plugin.manifest.id}@${plugin.manifest.version}`,
      });
      searchRunScheduler.registerServiceToken(run.id, serviceToken);
      searchRunScheduler.enqueue(run.id);

      return reply.code(202).send({
        run_id: run.id,
        status: run.status,
        plugin: {
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          digest: plugin.digest,
        },
        model_profile: profile,
        events_url: `/api/agent/searches/${run.id}/events`,
        result_url: `/api/agent/searches/${run.id}`,
        expires_at: run.expires_at,
      });
    } catch (e) {
      return sendRunError(reply, e);
    }
  });

  fastify.get("/:id", async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    try {
      const run = await getOwnedRun(id, { virtualKeyId: auth.virtualKey.id });
      const usage = await getRunUsage(run.id);
      const expired =
        run.status !== "expired" &&
        Date.now() > run.expires_at &&
        (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
      const result =
        run.status === "completed" && !expired
          ? await readRunResult(run)
          : null;

      return {
        run_id: run.id,
        status: expired ? "expired" : run.status,
        plugin: {
          id: run.plugin_id,
          version: run.plugin_version,
          digest: run.plugin_digest,
        },
        source: {
          type: run.source_type,
          snapshot_id: run.snapshot_id,
          commit: run.resolved_commit,
        },
        model_profile: run.model_profile,
        created_at: run.created_at,
        started_at: run.started_at,
        completed_at: run.completed_at,
        expires_at: run.expires_at,
        cancellation_requested_at: run.cancellation_requested_at,
        error: run.error_code
          ? { code: run.error_code, message: run.error_message }
          : null,
        usage: usage
          ? {
              turns: usage.turn_count,
              tool_calls: usage.tool_call_count,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cost: Number(usage.cost),
            }
          : null,
        result,
      };
    } catch (e) {
      return sendRunError(reply, e);
    }
  });

  fastify.get("/:id/events", async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    let run;
    try {
      run = await getOwnedRun(id, { virtualKeyId: auth.virtualKey.id });
    } catch (e) {
      return sendRunError(reply, e);
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
    let stream: RunStreamHandle | null = null;
    const close = () => {
      if (closed) return;
      closed = true;
      stream?.unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.end();
    };

    const send = (event: {
      seq: number;
      type: string;
      payload: Record<string, unknown>;
      created_at: number;
    }) => {
      reply.raw.write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
          run_id: run!.id,
          seq: event.seq,
          type: event.type,
          payload: event.payload,
          created_at: event.created_at,
        })}\n\n`,
      );
    };

    // 订阅先于重放建立（openStream 内部缓冲 + seq 去重），消除重放窗口的事件丢失
    stream = runEventHub.openStream(run.id, lastEventId, (event) => {
      send(event);
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

    request.raw.on("close", () => {
      close();
    });
    return reply;
  });

  fastify.post("/:id/cancel", async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    try {
      const run = await getOwnedRun(id, { virtualKeyId: auth.virtualKey.id });
      if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
        // 幂等：已终止的 run 再次 cancel 是无副作用的 no-op
        return {
          run_id: run.id,
          status: run.status,
          cancelled: run.status === "cancelled",
        };
      }
      const first = await agentSearchRunDb.requestCancellation(id);
      if (first) {
        searchRunScheduler.requestKill(id);
      }
      const current = (await agentSearchRunDb.getById(id)) ?? run;
      return {
        run_id: id,
        status: current.status,
        cancelled: current.status === "cancelled",
      };
    } catch (e) {
      return sendRunError(reply, e);
    }
  });
}
