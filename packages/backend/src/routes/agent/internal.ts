import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  internalCompletionRequestSchema,
  type SearchRunEventType,
} from "@llm-gateway/shared";
import {
  agentSearchRunDb,
  agentSearchUsageDb,
  virtualKeyDb,
} from "../../db/index.js";
import { hashServiceToken } from "../../agent/run/service-token.js";
import { runEventHub } from "../../agent/run/run-events.js";
import { searchRunScheduler } from "../../agent/run/scheduler.js";
import { costMappingService } from "../../services/cost-mapping.js";
import { normalizeUsageCounts } from "../../utils/usage-normalizer.js";
import type { AgentSearchRun } from "../../db/types.js";

const LOOPBACK_TIMEOUT_MS = Number(
  process.env.AGENT_INTERNAL_TIMEOUT_MS || 120_000,
);
/** worker 事件上报的白名单：只允许进度类事件，终态走 /report。 */
const WORKER_PROGRESS_EVENTS: readonly SearchRunEventType[] = [
  "tool.started",
  "tool.completed",
  "model.completed",
];

function serviceToken(request: FastifyRequest): string | undefined {
  const header = request.headers["x-agent-service-token"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

async function authorizeRun(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedRunId?: string,
): Promise<AgentSearchRun | null> {
  const token = serviceToken(request);
  if (!token) {
    reply.code(401).send({
      error: {
        message: "missing X-Agent-Service-Token",
        type: "invalid_request_error",
        param: null,
        code: "missing_token",
      },
    });
    return null;
  }
  const run = await agentSearchRunDb.findByServiceTokenHash(
    hashServiceToken(token),
  );
  if (!run || (expectedRunId && run.id !== expectedRunId)) {
    reply.code(401).send({
      error: {
        message: "invalid service token",
        type: "invalid_request_error",
        param: null,
        code: "invalid_token",
      },
    });
    return null;
  }
  if (run.status !== "running") {
    reply.code(409).send({
      error: {
        message: `run is ${run.status}`,
        type: "invalid_request_error",
        param: null,
        code: "run_not_active",
      },
    });
    return null;
  }
  if (run.cancellation_requested_at || Date.now() > run.expires_at) {
    reply.code(409).send({
      error: {
        message: "run is terminating",
        type: "invalid_request_error",
        param: null,
        code: "run_not_active",
      },
    });
    return null;
  }
  return run;
}

function opaiError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({
    error: { message, type: "invalid_request_error", param: null, code },
  });
}

/** 与 routes/config.ts 用量费用统计一致的每 token 计价公式。 */
async function computeCost(
  model: string | null,
  usage: unknown,
): Promise<number> {
  if (!model) return 0;
  const counts = normalizeUsageCounts(usage);
  const costInfo = await costMappingService.resolveModelCost(model);
  if (!costInfo?.info) return 0;
  const info = costInfo.info;
  let cost = 0;
  if (info.input_cost_per_token && counts.promptTokens) {
    cost += counts.promptTokens * Number(info.input_cost_per_token);
  }
  if (info.output_cost_per_token && counts.completionTokens) {
    cost += counts.completionTokens * Number(info.output_cost_per_token);
  }
  if (counts.cachedTokens) {
    const cacheReadCostPerToken =
      info.cache_read_cost_per_token ?? info.input_cost_per_token;
    if (cacheReadCostPerToken) {
      cost += counts.cachedTokens * Number(cacheReadCostPerToken);
    }
  }
  return cost;
}

/** 把网关侧计量累加到 run 用量行（token/cost 的唯一权威来源）。 */
async function accumulateUsage(
  run: AgentSearchRun,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  routedModel: string | null,
): Promise<void> {
  const existing = await agentSearchUsageDb.getByRunId(run.id);
  let models: string[] = [];
  if (existing?.model_route_metadata) {
    try {
      const parsed = JSON.parse(existing.model_route_metadata);
      if (Array.isArray(parsed?.models)) models = parsed.models;
    } catch {
      // 忽略损坏的元数据
    }
  }
  if (routedModel && !models.includes(routedModel)) models.push(routedModel);

  await agentSearchUsageDb.upsert({
    run_id: run.id,
    turn_count: existing?.turn_count ?? 0,
    tool_call_count: existing?.tool_call_count ?? 0,
    input_tokens: (existing?.input_tokens ?? 0) + inputTokens,
    output_tokens: (existing?.output_tokens ?? 0) + outputTokens,
    cost: Number(existing?.cost ?? 0) + cost,
    model_route_metadata: JSON.stringify({ models }),
    updated_at: Date.now(),
  });
}

export async function agentInternalRoutes(fastify: FastifyInstance) {
  /**
   * Worker → gateway 的受控模型通道：service token 鉴权后经 loopback
   * 复用 /v1/chat/completions 的完整路由/fallback/计量链路，
   * worker 永远接触不到 provider key 或用户 virtual key。
   */
  fastify.post("/completions", {
    bodyLimit: 8 * 1024 * 1024,
    handler: async (request, reply) => {
      const run = await authorizeRun(request, reply);
      if (!run) return reply;

      const parsed = internalCompletionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return opaiError(
          reply,
          400,
          "invalid_request",
          parsed.error.issues.map((i) => i.message).join("; "),
        );
      }
      const body = parsed.data;
      if (body.run_id !== run.id) {
        return opaiError(
          reply,
          401,
          "invalid_token",
          "service token is bound to a different run",
        );
      }
      if (body.model_profile !== run.model_profile) {
        return opaiError(
          reply,
          403,
          "profile_mismatch",
          `run is bound to model profile "${run.model_profile}"`,
        );
      }

      // 虚拟密钥自动放行：loopback 用 run 归属密钥鉴权与计量，用量记账到
      // 该密钥；默认所有可用密钥均可发起 Agent Search，无需预置内部密钥。
      const ownerKey = run.virtual_key_id
        ? await virtualKeyDb.getById(run.virtual_key_id)
        : undefined;
      if (!ownerKey || !ownerKey.enabled) {
        return opaiError(
          reply,
          503,
          "internal_model_unavailable",
          !run.virtual_key_id || !ownerKey
            ? "run owner virtual key not found"
            : "run owner virtual key disabled",
        );
      }
      const loopbackBase = `http://127.0.0.1:${process.env.PORT || 3000}`;

      let upstream: Response;
      try {
        upstream = await fetch(`${loopbackBase}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerKey.key_value}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: body.model_profile,
            messages: body.messages,
            tools: body.tools,
            max_tokens: body.max_tokens,
            stream: false,
          }),
          signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
        });
      } catch (e) {
        return opaiError(
          reply,
          502,
          "model_call_failed",
          `gateway model call failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const text = await upstream.text();
      if (!upstream.ok) {
        return reply
          .code(upstream.status)
          .header("content-type", "application/json")
          .send(text);
      }
      let completion: any;
      try {
        completion = JSON.parse(text);
      } catch {
        return opaiError(
          reply,
          502,
          "model_call_failed",
          "upstream returned non-JSON body",
        );
      }

      const usage = completion?.usage;
      const routedModel = completion?.model ?? null;
      const cost = await computeCost(routedModel, usage);
      await accumulateUsage(
        run,
        Number(usage?.prompt_tokens ?? 0),
        Number(usage?.completion_tokens ?? 0),
        cost,
        routedModel,
      );
      await runEventHub.append(run.id, "model.completed", {
        turn: body.turn,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
      });

      return reply.header("content-type", "application/json").send(completion);
    },
  });

  const progressEventSchema = z.object({
    type: z.enum(["tool.started", "tool.completed", "model.completed"]),
    payload: z.record(z.string(), z.unknown()).default({}),
  });

  fastify.post("/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await authorizeRun(request, reply, runId);
    if (!run) return reply;
    const parsed = progressEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return opaiError(reply, 400, "invalid_request", "invalid progress event");
    }
    if (!WORKER_PROGRESS_EVENTS.includes(parsed.data.type)) {
      return opaiError(
        reply,
        400,
        "invalid_request",
        `event type ${parsed.data.type} not allowed from worker`,
      );
    }
    await runEventHub.append(runId, parsed.data.type, parsed.data.payload);
    return reply.code(204).send();
  });

  const terminalReportSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("completed"),
      result: z.unknown(),
      usage: z.object({
        turns: z.number().int().min(0),
        tool_calls: z.number().int().min(0),
        input_tokens: z.number().int().min(0).default(0),
        output_tokens: z.number().int().min(0).default(0),
        cost: z.number().min(0).default(0),
        model_route_metadata: z
          .record(z.string(), z.unknown())
          .nullable()
          .default(null),
      }),
    }),
    z.object({
      kind: z.literal("failed"),
      error_code: z.string().min(1).max(128),
      error_message: z.string().max(4000),
      usage: z
        .object({
          turns: z.number().int().min(0),
          tool_calls: z.number().int().min(0),
          input_tokens: z.number().int().min(0).default(0),
          output_tokens: z.number().int().min(0).default(0),
          cost: z.number().min(0).default(0),
          model_route_metadata: z
            .record(z.string(), z.unknown())
            .nullable()
            .default(null),
        })
        .optional(),
    }),
    z.object({
      kind: z.literal("budget_exceeded"),
      error_message: z.string().max(4000),
      usage: z
        .object({
          turns: z.number().int().min(0),
          tool_calls: z.number().int().min(0),
          input_tokens: z.number().int().min(0).default(0),
          output_tokens: z.number().int().min(0).default(0),
          cost: z.number().min(0).default(0),
          model_route_metadata: z
            .record(z.string(), z.unknown())
            .nullable()
            .default(null),
        })
        .optional(),
    }),
  ]);

  fastify.post("/runs/:runId/report", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await authorizeRun(request, reply, runId);
    if (!run) return reply;
    const parsed = terminalReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return opaiError(
        reply,
        400,
        "invalid_request",
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    }
    const accepted = searchRunScheduler.reportTerminal(
      runId,
      parsed.data as any,
    );
    if (!accepted) {
      return opaiError(reply, 409, "run_not_active", "run is not executing");
    }
    return reply.code(202).send({ accepted: true });
  });
}
