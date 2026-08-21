import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { EXPERT_ROUTING_MODEL_REPO } from "@llm-gateway/shared";
import { classifyWithLocalOnnx } from "../services/expert-router/local/classifier.js";
import { intentClassifyLogDb } from "../db/index.js";
import {
  getLocalClassifierError,
  isLocalClassifierDisabled,
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
    const { virtualKeyValue, virtualKey } = authResult;

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

    if (isLocalClassifierDisabled()) {
      return sendError(reply, 503, {
        message:
          "Local intent classifier is disabled on this deployment (LOCAL_INTENT_CLASSIFIER=off)",
        type: "service_unavailable",
        errCode: "classifier_disabled",
      });
    }

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

      // Log every successful classification so dashboard intent-classify stats
      // cover both this API and Expert Router runs. Persistence failures must
      // never break the classification response.
      intentClassifyLogDb
        .create({
          id: nanoid(),
          virtual_key_id: virtualKey?.id || null,
          classifier_model: `onnx/${EXPERT_ROUTING_MODEL_REPO}`,
          top_label: result.ranked[0]?.label || null,
          latency_ms: result.latencyMs,
          seq_len: result.seqLen,
          input_truncated: result.truncated,
        })
        .catch((e: any) =>
          memoryLogger.warn(
            `Intent classify log persistence failed: ${e?.message || e}`,
            "IntentApi",
          ),
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
