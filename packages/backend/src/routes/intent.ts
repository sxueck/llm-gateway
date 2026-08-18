import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { EXPERT_ROUTING_MODEL_REPO } from "@llm-gateway/shared";
import { classifyWithLocalOnnx } from "../services/expert-router/local/classifier.js";
import {
  getLocalClassifierError,
  isLocalClassifierReady,
} from "../services/expert-router/local/model-assets.js";
import { memoryLogger } from "../services/logger.js";
import {
  authenticateVirtualKey,
  extractVirtualKeyAuthHeader,
} from "./proxy/auth.js";

const classifySchema = z.object({
  input: z.string().min(1),
  top_n: z.number().int().positive().optional(),
  max_tokens: z.number().int().min(1).max(1024).default(1024),
});

interface ApiErrorBody {
  error: { message: string; type: string; param: null; code: string };
}

function sendError(
  reply: FastifyReply,
  code: number,
  body: { message: string; type: string; errCode: string },
) {
  return reply.code(code).send({
    error: {
      message: body.message,
      type: body.type,
      param: null,
      code: body.errCode,
    },
  } satisfies ApiErrorBody);
}

/**
 * External intent classification API. Runs the same local ONNX classifier the
 * Expert Router uses, but returns the raw ranked label distribution (no expert
 * mapping, rejection decision, or session binding). Callers authenticate with
 * any virtual key and may slice the distribution via `top_n`.
 */
export async function intentRoutes(fastify: FastifyInstance) {
  fastify.post("/classify", async (request, reply) => {
    const authResult = await authenticateVirtualKey(
      extractVirtualKeyAuthHeader(request.headers),
    );
    if ("error" in authResult) {
      return reply.code(authResult.error.code).send(authResult.error.body);
    }
    const { virtualKeyValue } = authResult;

    const parsed = classifySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join(".");
      return sendError(reply, 400, {
        message: path
          ? `Invalid request: ${path} ${issue.message}`
          : "Invalid request body",
        type: "invalid_request_error",
        errCode: "validation_error",
      });
    }

    const { input, top_n: topN, max_tokens: maxTokens } = parsed.data;

    if (!isLocalClassifierReady()) {
      const detail = getLocalClassifierError();
      return sendError(reply, 503, {
        message: detail
          ? `Local intent classifier is not ready: ${detail}`
          : "Local intent classifier is not ready",
        type: "service_unavailable",
        errCode: "classifier_not_ready",
      });
    }

    try {
      const result = await classifyWithLocalOnnx(input, maxTokens);
      const ranked = topN ? result.ranked.slice(0, topN) : result.ranked;
      const vkDisplay = `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`;
      memoryLogger.info(
        `Intent classify | key=${vkDisplay} | labels=${ranked.length}/${result.ranked.length} | latency=${result.latencyMs}ms`,
        "IntentApi",
      );

      reply.header("Content-Type", "application/json");
      return reply.send({
        object: "intent_classification",
        model: `onnx/${EXPERT_ROUTING_MODEL_REPO}`,
        revision: result.revision,
        labels: ranked.map((r) => ({ label: r.label, score: r.score })),
        total_labels: result.ranked.length,
        seq_len: result.seqLen,
        input_truncated: result.truncated,
        latency_ms: result.latencyMs,
      });
    } catch (e: any) {
      memoryLogger.error(
        `Intent classify failed: ${e?.message || e}`,
        "IntentApi",
      );
      return sendError(reply, 500, {
        message: e?.message || "Intent classification failed",
        type: "internal_error",
        errCode: "classification_error",
      });
    }
  });
}
