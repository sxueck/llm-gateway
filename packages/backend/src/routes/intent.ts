import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { intentClassifyLogDb } from "../db/index.js";
import {
  classifyIntent,
  IntentRouterApiError,
} from "../services/expert-router/intent-router-client.js";
import { memoryLogger } from "../services/logger.js";
import {
  authenticateVirtualKey,
  extractVirtualKeyAuthHeader,
} from "./proxy/auth.js";

const classifySchema = z.object({
  input: z.string().min(1),
  top_n: z.number().int().positive().optional(),
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
 * Gateway-facing intent classification API. It authenticates virtual keys and
 * proxies classification to the separately deployed Intent Router API.
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

    try {
      const result = await classifyIntent(parsed.data.input);
      const item = result.data[0];
      const labels = parsed.data.top_n
        ? item.labels.slice(0, parsed.data.top_n)
        : item.labels;
      const vkDisplay = `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`;
      memoryLogger.info(
        `Intent classify | key=${vkDisplay} | labels=${labels.length}/${item.labels.length} | latency=${result.latency_ms}ms`,
        "IntentApi",
      );

      intentClassifyLogDb
        .create({
          id: nanoid(),
          virtual_key_id: virtualKey?.id || null,
          classifier_model: result.model,
          top_label: item.labels[0]?.label || item.route.intent,
          latency_ms: Math.round(result.latency_ms),
          seq_len: item.token_count,
          input_truncated: item.truncated,
        })
        .catch((error: unknown) =>
          memoryLogger.warn(
            `Intent classify log persistence failed: ${error instanceof Error ? error.message : error}`,
            "IntentApi",
          ),
        );

      return reply.send({
        object: "intent_classification",
        model: result.model,
        revision: result.revision,
        labels: labels.map(({ label, score }) => ({ label, score })),
        total_labels: item.labels.length,
        seq_len: item.token_count,
        input_truncated: item.truncated,
        latency_ms: result.latency_ms,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      memoryLogger.error(`Intent classify failed: ${message}`, "IntentApi");
      if (error instanceof IntentRouterApiError && !error.configured) {
        return sendError(reply, 503, {
          message,
          type: "service_unavailable",
          errCode: "classifier_unavailable",
        });
      }
      return sendError(reply, 502, {
        message,
        type: "api_error",
        errCode: "classification_error",
      });
    }
  });
}
