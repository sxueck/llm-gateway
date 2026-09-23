import { FastifyReply } from "fastify";
import { memoryLogger } from "../../services/logger.js";
import type {
  AnthropicRequest,
  AnthropicStreamEvent,
} from "../../types/anthropic.js";
import { normalizeAnthropicError } from "../../utils/http-error-normalizer.js";
import { EmptyOutputError } from "../../errors/empty-output-error.js";
import {
  filterForwardedHeaders,
  sanitizeCustomHeaders,
} from "../../utils/header-sanitizer.js";
import { PiiStreamRestorer } from "../../services/pii-protection-service.js";
import type { PiiProtectionContext } from "../../services/pii-protection-types.js";
import { removeV1Suffix } from "../../utils/api-endpoint-builder.js";
import { upstreamFetch } from "../../utils/upstream-fetch.js";
import { normalizeAnthropicRequest } from "../../utils/anthropic-request-normalizer.js";
import { BoundedChunkRecorder } from "../../utils/bounded-chunk-recorder.js";
import { AnthropicStreamNormalizer } from "./stream-normalizer.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface StreamTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamChunks: string[];
  /** Time to first upstream stream event (ms), when an event was observed. */
  tffbMs?: number;
}

function buildMessagesUrl(config: any): string {
  const base = removeV1Suffix(config.baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
  return `${base}/v1/messages`;
}

function buildUpstreamHeaders(
  config: any,
  forwardedHeaders: Record<string, string> | undefined,
  requestBody: AnthropicRequest,
  stream: boolean,
): Record<string, string> {
  const modelAttrHeaders = sanitizeCustomHeaders(
    config.modelAttributes?.headers,
  );
  const clientForwarded = filterForwardedHeaders(
    config.modelAttributes?.headers,
    forwardedHeaders,
  );
  const clientBeta = Object.entries(forwardedHeaders || {}).find(
    ([name]) => name.toLowerCase() === "anthropic-beta",
  )?.[1];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const betas: string[] = [];
  for (const source of [modelAttrHeaders, clientForwarded]) {
    for (const [name, value] of Object.entries(source || {})) {
      const key = name.toLowerCase();
      if (key === "anthropic-beta") {
        if (source === modelAttrHeaders && !/[\r\n]/.test(value))
          betas.push(value);
      } else if (
        key !== "authorization" &&
        key !== "x-api-key" &&
        key !== "proxy-authorization" &&
        key !== "content-type" &&
        key !== "accept"
      ) {
        headers[name] = value;
      }
    }
  }
  if (clientBeta && !/[\r\n]/.test(clientBeta)) betas.push(clientBeta);
  if (Array.isArray(requestBody.betas))
    betas.push(
      ...requestBody.betas.filter(
        (beta): beta is string =>
          typeof beta === "string" && !/[\r\n]/.test(beta),
      ),
    );
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  headers["x-api-key"] = config.apiKey;
  return headers;
}

function buildRequestParams(
  config: any,
  requestBody: AnthropicRequest,
  stream: boolean = false,
): any {
  const { betas: _betas, ...body } = requestBody;
  return { ...body, model: config.model, ...(stream ? { stream: true } : {}) };
}

/** 优先保留上游返回的 Anthropic 错误 envelope，缺失时按 HTTP 状态归一。 */
function normalizeRawUpstreamError(
  status: number,
  bodyText: string,
): { statusCode: number; errorResponse: any } {
  let message = "";
  let upstreamType: string | undefined;
  try {
    const parsed = JSON.parse(bodyText);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.error &&
      typeof parsed.error === "object"
    ) {
      if (typeof parsed.error.message === "string")
        message = parsed.error.message;
      if (typeof parsed.error.type === "string")
        upstreamType = parsed.error.type;
    }
  } catch {
    // non-JSON error body: fall through to status-based normalization
  }

  const norm = normalizeAnthropicError({
    status,
    message: message || `Anthropic upstream returned HTTP ${status}`,
  });
  return {
    statusCode: norm.statusCode,
    errorResponse: {
      type: "error",
      error: {
        type: upstreamType || norm.errorType,
        message: norm.message,
      },
    },
  };
}

const DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT = Math.max(
  parseInt(process.env.ANTHROPIC_STREAM_EMPTY_RETRY_LIMIT || "1", 10),
  0,
);

function getAnthropicEmptyRetryLimit(config: any): number {
  const configured = config.modelAttributes?.anthropic_empty_retry_limit;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT;
}

const CONTENT_BLOCK_START_TYPES = new Set([
  "tool_use",
  "server_tool_use",
  "thinking",
  "compaction",
]);

function hasAnthropicContent(event: AnthropicStreamEvent): boolean {
  if (event.type === "content_block_start") {
    return CONTENT_BLOCK_START_TYPES.has(event.content_block?.type ?? "");
  }
  if (event.type !== "content_block_delta" || !event.delta) {
    return false;
  }
  switch (event.delta.type) {
    case "text_delta":
      return (event.delta.text || "").trim().length > 0;
    case "thinking_delta":
      return (event.delta.thinking || "").trim().length > 0;
    case "signature_delta":
      return (event.delta.signature || "").trim().length > 0;
    case "input_json_delta":
      return true;
    case "compaction_delta":
      return ((event.delta as any).content || "").trim().length > 0;
    default:
      return false;
  }
}

/**
 * Parse an SSE byte stream into Anthropic stream events. Handles CRLF framing
 * and ignores comment/keep-alive lines; malformed JSON frames are skipped
 * rather than aborting the stream.
 */
async function* parseSseEvents(
  response: Response,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = (response.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;

      try {
        yield JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        // Skip unparseable frame
      }
    }
  }
}

function ensureSseHeaders(reply: FastifyReply): void {
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }
}

interface StreamAttemptResult {
  promptTokens: number;
  completionTokens: number;
  hasAssistantContent: boolean;
  streamChunks: string[];
  tffbMs?: number;
}

interface AnthropicPiiDeltaKey {
  blockIndex: number;
  deltaType: "text_delta" | "thinking_delta";
}

function buildAnthropicPiiDeltaKey(
  blockIndex: number,
  deltaType: "text_delta" | "thinking_delta",
): string {
  return `anthropic:block:${blockIndex}:${deltaType === "text_delta" ? "text" : "thinking"}`;
}

function buildAnthropicPiiFlushEvent(
  key: AnthropicPiiDeltaKey,
  text: string,
): AnthropicStreamEvent {
  return {
    type: "content_block_delta",
    index: key.blockIndex,
    delta:
      key.deltaType === "text_delta"
        ? { type: "text_delta", text }
        : { type: "thinking_delta", thinking: text },
  };
}

function serializeSseEvent(event: { type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Consume one upstream SSE attempt, re-emitting normalized Anthropic events.
 * TFFB is measured at the first upstream event observed by the gateway — the
 * same measurement point as utils/stream-processor.ts — relative to
 * `upstreamRequestStartedAt` (captured right before the upstream fetch).
 */
export async function consumeAnthropicStreamAttempt(
  events: AsyncIterable<AnthropicStreamEvent>,
  reply: FastifyReply,
  flushOnEmptyOutput: boolean,
  piiCtx?: PiiProtectionContext | null,
  upstreamRequestStartedAt?: number,
): Promise<StreamAttemptResult> {
  let inputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;
  let buffering = true;
  let tffbMs: number | undefined;
  const pendingChunks: string[] = [];
  let hasAssistantContent = false;
  const streamChunks = new BoundedChunkRecorder();

  const piiRestorer = piiCtx ? new PiiStreamRestorer(piiCtx) : null;
  const usedPiiKeys = new Map<string, AnthropicPiiDeltaKey>();

  const streamNormalizer = new AnthropicStreamNormalizer();

  const flushPendingChunks = () => {
    if (!buffering) return;
    buffering = false;
    ensureSseHeaders(reply);
    for (const chunk of pendingChunks) {
      reply.raw.write(chunk);
      streamChunks.record(chunk);
    }
    pendingChunks.length = 0;
  };

  const writeChunk = (chunk: string) => {
    if (buffering) {
      pendingChunks.push(chunk);
      return;
    }

    ensureSseHeaders(reply);
    reply.raw.write(chunk);
    streamChunks.record(chunk);
  };

  const flushPiiKey = (key: string) => {
    if (!piiRestorer) return;
    const keyMeta = usedPiiKeys.get(key);
    if (!keyMeta) return;

    const flushedText = piiRestorer.flush(key);
    if (!flushedText) return;

    const flushEvent = buildAnthropicPiiFlushEvent(keyMeta, flushedText);
    writeChunk(serializeSseEvent(flushEvent));
  };

  const flushPiiKeysForBlock = (blockIndex: number | undefined) => {
    if (blockIndex === undefined) return;
    for (const [key, keyMeta] of usedPiiKeys) {
      if (keyMeta.blockIndex === blockIndex) {
        flushPiiKey(key);
      }
    }
  };

  const flushAllPiiKeys = () => {
    for (const key of usedPiiKeys.keys()) {
      flushPiiKey(key);
    }
  };

  const emitNormalizedEvent = (eventData: AnthropicStreamEvent) => {
    if (!hasAssistantContent && hasAnthropicContent(eventData)) {
      hasAssistantContent = true;
      flushPendingChunks();
    }

    if (piiRestorer) {
      const shouldFlushBlockKeys =
        eventData.type === "content_block_stop" ||
        eventData.type === "message_stop" ||
        (eventData.type === "content_block_delta" &&
          eventData.delta?.type !== "text_delta" &&
          eventData.delta?.type !== "thinking_delta");

      if (shouldFlushBlockKeys && eventData.type === "message_stop") {
        flushAllPiiKeys();
      } else if (shouldFlushBlockKeys) {
        flushPiiKeysForBlock(eventData.index);
      }
    }

    if (
      piiRestorer &&
      eventData.type === "content_block_delta" &&
      eventData.delta
    ) {
      const fieldByDeltaType = {
        text_delta: "text",
        thinking_delta: "thinking",
      } as const;
      const deltaType = eventData.delta.type as keyof typeof fieldByDeltaType;
      const field = fieldByDeltaType[deltaType];
      const blockIndex = eventData.index ?? 0;
      if (field && typeof (eventData.delta as any)[field] === "string") {
        const key = buildAnthropicPiiDeltaKey(blockIndex, deltaType);
        usedPiiKeys.set(key, { blockIndex, deltaType });
        (eventData.delta as any)[field] = piiRestorer.process(
          key,
          (eventData.delta as any)[field],
        );
      }
    }

    writeChunk(serializeSseEvent(eventData));
  };

  for await (const sourceEvent of events) {
    // Record TFFB on the first upstream stream event observed.
    if (tffbMs === undefined && upstreamRequestStartedAt !== undefined) {
      tffbMs = Date.now() - upstreamRequestStartedAt;
    }

    if (sourceEvent.type === "message_start") {
      if (sourceEvent.message?.usage) {
        inputTokens = sourceEvent.message.usage.input_tokens || 0;
        const anyUsage: any = sourceEvent.message.usage as any;
        cacheCreationInputTokens = anyUsage?.cache_creation_input_tokens || 0;
        cacheReadInputTokens = anyUsage?.cache_read_input_tokens || 0;
      }
    } else if (sourceEvent.type === "message_delta") {
      const anyUsage: any = (sourceEvent as any).usage;
      if (anyUsage && anyUsage.output_tokens !== undefined) {
        outputTokens = anyUsage.output_tokens as number;
      }
    }

    for (const eventData of streamNormalizer.push(sourceEvent)) {
      emitNormalizedEvent(eventData);
    }
  }
  for (const eventData of streamNormalizer.finish()) {
    emitNormalizedEvent(eventData);
  }

  // Flush any pending PII restoration buffers
  if (piiRestorer) {
    flushAllPiiKeys();
  }

  if (hasAssistantContent || flushOnEmptyOutput) {
    flushPendingChunks();
  }

  if (hasAssistantContent && !reply.raw.writableEnded) {
    reply.raw.end();
  }

  const promptTokens =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const completionTokens = outputTokens;

  return {
    promptTokens,
    completionTokens,
    hasAssistantContent,
    streamChunks: streamChunks.chunks,
    tffbMs,
  };
}

export async function makeAnthropicRequest(
  config: any,
  requestBody: AnthropicRequest,
  forwardedHeaders?: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<HttpResponse> {
  const normalizedRequest = normalizeAnthropicRequest(
    config.model,
    requestBody,
  );
  const requestParams = buildRequestParams(config, normalizedRequest);

  try {
    const response = await upstreamFetch(buildMessagesUrl(config), {
      method: "POST",
      headers: buildUpstreamHeaders(
        config,
        forwardedHeaders,
        normalizedRequest,
        false,
      ),
      body: JSON.stringify(requestParams),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: abortSignal,
    });
    const bodyText = await response.text();

    if (!response.ok) {
      const { statusCode, errorResponse } = normalizeRawUpstreamError(
        response.status,
        bodyText,
      );
      return {
        statusCode,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(errorResponse),
      };
    }

    return {
      statusCode: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") || "application/json",
      },
      body: bodyText,
    };
  } catch (error: any) {
    const norm = normalizeAnthropicError(error);
    return {
      statusCode: norm.statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "error",
        error: {
          type: norm.errorType,
          message: norm.message,
        },
      }),
    };
  }
}

/** Enrich a transport error with the normalized upstream status/envelope so the
 *  route handler can decide between a protocol-correct smart-routing retry and
 *  delivering the error. */
function enrichUpstreamStreamError(status: number, bodyText: string): Error {
  const { statusCode, errorResponse } = normalizeRawUpstreamError(
    status,
    bodyText,
  );
  const enriched = new Error(
    errorResponse?.error?.message ||
      `Anthropic stream request failed with HTTP ${status}`,
  );
  (enriched as any).statusCode = statusCode;
  (enriched as any).errorResponse = errorResponse;
  return enriched;
}

export async function makeAnthropicStreamRequest(
  config: any,
  requestBody: AnthropicRequest,
  reply: FastifyReply,
  forwardedHeaders?: Record<string, string>,
  piiCtx?: PiiProtectionContext | null,
  abortSignal?: AbortSignal,
): Promise<StreamTokenUsage> {
  const normalizedRequest = normalizeAnthropicRequest(
    config.model,
    requestBody,
  );
  const requestParams = buildRequestParams(config, normalizedRequest, true);
  const headers = buildUpstreamHeaders(
    config,
    forwardedHeaders,
    normalizedRequest,
    true,
  );
  const url = buildMessagesUrl(config);
  const totalAttempts = Math.max(1, getAnthropicEmptyRetryLimit(config) + 1);
  let lastEmptyError: EmptyOutputError | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      // Anchor for this attempt's TFFB measurement (first upstream event).
      const upstreamRequestStartedAt = Date.now();
      const response = await upstreamFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestParams),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: abortSignal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw enrichUpstreamStreamError(response.status, bodyText);
      }

      const attemptResult = await consumeAnthropicStreamAttempt(
        parseSseEvents(response),
        reply,
        attempt === totalAttempts,
        piiCtx,
        upstreamRequestStartedAt,
      );

      if (!attemptResult.hasAssistantContent) {
        if (attempt < totalAttempts) {
          memoryLogger.warn(
            `Anthropic 流式无实际输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
            "Anthropic",
          );
          lastEmptyError = new EmptyOutputError(
            "Anthropic stream completed without assistant output",
            { source: "claude", attempt, totalAttempts },
          );
          continue;
        }

        throw (
          lastEmptyError ||
          new EmptyOutputError(
            "Anthropic stream ended without assistant output",
            { source: "claude", totalAttempts },
          )
        );
      }

      return {
        promptTokens: attemptResult.promptTokens,
        completionTokens: attemptResult.completionTokens,
        totalTokens:
          attemptResult.promptTokens + attemptResult.completionTokens,
        streamChunks: attemptResult.streamChunks,
        tffbMs: attemptResult.tffbMs,
      };
    } catch (error: any) {
      if (error instanceof EmptyOutputError) {
        // The empty-output terminal state may have already flushed buffered
        // chunks (headers sent). The handler owns response termination so it can
        // still attempt a smart-routing retry when nothing was written.
        throw error;
      }
      if ((error as any)?.errorResponse) {
        // Already enriched upstream error from the !response.ok branch above.
        throw error;
      }

      memoryLogger.error(
        `Anthropic stream request failed: ${error.message}`,
        "Anthropic",
        { error: error.stack },
      );

      const norm = normalizeAnthropicError(error);
      const enriched = new Error(
        norm.message || "Anthropic stream request failed",
      );
      (enriched as any).statusCode = norm.statusCode;
      (enriched as any).errorResponse = {
        type: "error",
        error: {
          type: norm.errorType,
          message: norm.message,
        },
      };
      throw enriched;
    }
  }
  throw new Error("Anthropic stream retries exhausted");
}
