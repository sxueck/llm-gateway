import { FastifyRequest, FastifyReply } from "fastify";
import { memoryLogger } from "../../services/logger.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";
import { shouldRetrySmartRouting } from "../proxy/routing.js";
import type { ModelResolutionResult } from "../proxy/model-resolver.js";
import { calculateTokensIfNeeded } from "../proxy/token-calculator.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import {
  shouldLogRequestBody,
  getModelForLogging,
} from "../proxy/handlers/shared.js";
import { truncateRequestBody } from "../../utils/request-logger.js";
import { EmptyOutputError } from "../../errors/empty-output-error.js";
import type { ProtocolConfig } from "../../services/protocol-adapter.js";
import type { VirtualKey } from "../../types/index.js";
import { extractIp } from "../../utils/ip.js";
import { getRequestUserAgent } from "../../utils/http.js";
import { requestHeaderForwardingService } from "../../services/request-header-forwarding.js";
import { upstreamFetch } from "../../utils/upstream-fetch.js";
import { BoundedChunkRecorder } from "../../utils/bounded-chunk-recorder.js";
import {
  CLIENT_ABORTED_MESSAGE,
  isClientAbort,
} from "../../utils/client-abort.js";

/**
 * Pipeline context threaded from the Gemini route into the native handlers so
 * every terminal upstream outcome is recorded against the smart-routing
 * circuit key (modelResult.circuitBreakerKey) and retry-eligible failures can
 * re-enter the Gemini handlers on the next target.
 */
export interface GeminiNativeRequestOptions {
  /** Smart-routing circuit key; falls back to the bare provider id. */
  circuitBreakerKey?: string;
  modelResult?: ModelResolutionResult;
  virtualKeyValue?: string;
  retryBodySnapshot?: any;
  /** Shared exactly-one-row guard; set by the dispatching proxy handler. */
  auditState?: { auditLogged?: boolean };
}

const DEFAULT_GEMINI_EMPTY_RETRY_LIMIT = Math.max(
  parseInt(process.env.GEMINI_STREAM_EMPTY_RETRY_LIMIT || "1", 10),
  0,
);

/** Build the native passthrough upstream URL, surfacing malformed baseUrl clearly. */
function buildNativeUpstreamUrl(upstreamBase: string, path: string): URL {
  try {
    return new URL(upstreamBase + path);
  } catch {
    throw new Error(
      `Gemini native baseUrl is not a valid URL: "${upstreamBase}"`,
    );
  }
}

function getGeminiEmptyRetryLimit(protocolConfig: ProtocolConfig): number {
  const configured = protocolConfig.modelAttributes?.gemini_empty_retry_limit;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_GEMINI_EMPTY_RETRY_LIMIT;
}

function hasAssistantSignalInParts(parts: any[] | undefined | null): boolean {
  if (!Array.isArray(parts)) return false;

  return parts.some((part) => {
    if (part == null) return false;

    if (typeof part === "string") {
      return part.trim().length > 0;
    }

    if (typeof part !== "object") {
      return false;
    }

    if (typeof part.text === "string" && part.text.trim().length > 0) {
      return true;
    }

    if (Array.isArray(part.parts) && hasAssistantSignalInParts(part.parts)) {
      return true;
    }

    // 检查其它字段（函数调用、inlineData 等）是否存在有效内容
    return Object.keys(part).some((key) => {
      if (key === "text" || key === "parts") return false;
      const value = (part as any)[key];
      if (value == null) return false;
      if (typeof value === "string") return value.trim().length > 0;
      if (typeof value === "number" || typeof value === "boolean") return true;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "object") return Object.keys(value).length > 0;
      return false;
    });
  });
}

function inspectGeminiContent(content: any): boolean {
  if (!content) return false;

  if (Array.isArray(content)) {
    return content.some((item) => inspectGeminiContent(item));
  }

  if (typeof content.text === "string" && content.text.trim().length > 0) {
    return true;
  }

  if (hasAssistantSignalInParts(content.parts)) {
    return true;
  }

  if (Array.isArray(content.contents)) {
    return content.contents.some((item: any) => inspectGeminiContent(item));
  }

  return false;
}

function hasGeminiAssistantContent(payload: any): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (Array.isArray(payload.candidates)) {
    for (const candidate of payload.candidates) {
      if (inspectGeminiContent(candidate?.content)) {
        return true;
      }
      if (
        Array.isArray(candidate?.contents) &&
        candidate.contents.some((item: any) => inspectGeminiContent(item))
      ) {
        return true;
      }
    }
  }

  if (
    Array.isArray(payload.contents) &&
    payload.contents.some((item: any) => inspectGeminiContent(item))
  ) {
    return true;
  }

  if (payload.delta) {
    if (
      typeof payload.delta.text === "string" &&
      payload.delta.text.trim().length > 0
    ) {
      return true;
    }
    if (hasAssistantSignalInParts(payload.delta.parts)) {
      return true;
    }
  }

  if (typeof payload.text === "string" && payload.text.trim().length > 0) {
    return true;
  }

  return false;
}

function isGeminiErrorPayload(payload: any): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  // 只识别最明显的错误/拦截信号，避免过度推断
  if (payload.error) return true;
  if (payload.promptFeedback && payload.promptFeedback.blockReason) return true;

  return false;
}

function extractSseDataPayload(eventChunk: string): string | null {
  if (!eventChunk) return null;
  const lines = eventChunk.split("\n");
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine.startsWith("data:")) continue;
    dataLines.push(rawLine.replace(/^data:\s?/, ""));
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join("\n").trim();
  return payload.length > 0 ? payload : null;
}

interface GeminiStreamAttemptResult {
  streamChunks: string[];
  totalBytes: number;
  hasAssistantContent: boolean;
  bypassGuard: boolean;
  /** Time to first upstream SSE byte for the winning attempt, if measured. */
  tffbMs?: number;
}

function buildUpstreamHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
  apiKey: string,
  isStream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (isStream) {
    headers["accept"] = "text/event-stream";
  }

  // Only forward a minimal, explicit set of client headers.
  Object.assign(
    headers,
    requestHeaderForwardingService.buildForwardedHeaders(requestHeaders as any),
  );

  // 添加 API Key 认证头
  headers["x-goog-api-key"] = apiKey;
  headers["x-api-key"] = apiKey;
  headers["api-key"] = apiKey;

  return headers;
}

export async function handleGeminiNativeNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: ProtocolConfig,
  path: string,
  virtualKey: VirtualKey,
  providerId: string,
  startTime: number,
  vkDisplay: string,
  currentModel?: any,
  options?: GeminiNativeRequestOptions,
): Promise<void> {
  const method = request.method;
  const requestUserAgent = getRequestUserAgent(request);
  const requestIp = extractIp(request);
  const circuitBreakerKey = options?.circuitBreakerKey || providerId;

  memoryLogger.info(
    `Gemini 原生透传 (非流式): ${method} ${path} | virtual key: ${vkDisplay}`,
    "GeminiNative",
  );

  const baseForNative =
    protocolConfig.nativeBaseUrl || protocolConfig.baseUrl || "";
  const upstreamBase = baseForNative.replace(/\/+$/, "");
  if (!upstreamBase) {
    throw new Error("Gemini native baseUrl is not configured");
  }
  const upstreamPath = path.startsWith("/") ? path : "/" + path;
  const url = buildNativeUpstreamUrl(upstreamBase, upstreamPath);
  url.searchParams.set("key", protocolConfig.apiKey);

  const submittedModelIdentifier = protocolConfig.model;
  memoryLogger.info(
    `Gemini 上游提交: 完整URL="${url.toString().replace(/key=[^&]+/, "key=***")}" | model_identifier="${submittedModelIdentifier}"`,
    "GeminiNative",
  );

  const upstreamHeaders = buildUpstreamHeaders(
    request.headers as Record<string, string | string[] | undefined>,
    protocolConfig.apiKey,
    false,
  );

  let requestBody: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    requestBody = JSON.stringify(request.body || {});
  }

  const abortController = new AbortController();
  request.raw.on("close", () => {
    abortController.abort();
  });

  try {
    const upstreamResponse = await upstreamFetch(url.toString(), {
      method,
      headers: upstreamHeaders,
      body: requestBody,
      signal: abortController.signal,
    });

    const responseText = await upstreamResponse.text();
    const duration = Date.now() - startTime;

    let responseData: any;
    let tokenCount: any = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      responseData = JSON.parse(responseText);

      if (responseData.usageMetadata) {
        tokenCount = await calculateTokensIfNeeded(
          responseData.usageMetadata.totalTokenCount || 0,
          request.body,
          responseData,
          undefined,
          responseData.usageMetadata.promptTokenCount || 0,
          responseData.usageMetadata.candidatesTokenCount || 0,
        );
      }
    } catch {
      // Best-effort usage extraction: a non-JSON body or a counting failure
      // must never break the proxied response, so keep defaults and continue.
    }

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest =
      shouldLogBody && requestBody
        ? truncateRequestBody(JSON.parse(requestBody))
        : undefined;
    const isSuccess =
      upstreamResponse.status >= 200 && upstreamResponse.status < 300;

    // Record the breaker verdict for this terminal upstream outcome against the
    // pipeline circuit key before anything is sent, so a retry dispatch below
    // cannot skip accounting for the failed target.
    if (isSuccess) {
      circuitBreaker.recordSuccess(circuitBreakerKey);
    } else {
      circuitBreaker.recordFailure(
        circuitBreakerKey,
        new Error(`HTTP ${upstreamResponse.status}`),
      );
    }

    logApiRequestAsync({
      virtualKey,
      providerId,
      model: getModelForLogging(request.body, currentModel),
      tokenCount,
      status: isSuccess ? "success" : "error",
      responseTime: duration,
      errorMessage: isSuccess ? undefined : responseText.substring(0, 500),
      truncatedRequest,
      cacheHit: 0,
      ip: requestIp,
      userAgent: requestUserAgent,
    });
    if (options?.auditState) {
      options.auditState.auditLogged = true;
    }

    // Smart-routing retry (OpenAI parity): on a retry-eligible upstream failure,
    // switch to the next target while the response is still unsent. The failed
    // target was already breaker-recorded and audited above; the retry re-enters
    // the Gemini-native handlers with a pristine body, never another protocol's.
    if (
      !isSuccess &&
      options?.modelResult?.canRetry &&
      options?.virtualKeyValue &&
      shouldRetrySmartRouting(upstreamResponse.status) &&
      !reply.sent
    ) {
      try {
        const { handleNonStreamRetry } =
          await import("../proxy/retry-handler.js");
        const retried = await handleNonStreamRetry(
          request,
          reply,
          upstreamResponse.status,
          {
            virtualKey,
            virtualKeyValue: options.virtualKeyValue,
            vkDisplay,
            modelResult: options.modelResult,
            currentModel,
            startTime,
            entrypointProtocol: "gemini",
            retryBodySnapshot: options.retryBodySnapshot,
          },
        );
        if (retried) {
          return;
        }
        memoryLogger.warn(`智能路由重试失败: 没有更多可用目标`, "Gemini");
      } catch (retryError: any) {
        memoryLogger.warn(
          `智能路由重试分发异常(已忽略): ${retryError?.message || retryError}`,
          "Gemini",
        );
      }
    }

    const excludedResponseHeaders = [
      "content-length",
      "transfer-encoding",
      "connection",
    ];
    upstreamResponse.headers.forEach((value, key) => {
      if (!excludedResponseHeaders.includes(key.toLowerCase())) {
        reply.header(key, value);
      }
    });
    reply.code(upstreamResponse.status);

    memoryLogger.info(
      `Gemini 原生透传完成: ${upstreamResponse.status} | ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      "GeminiNative",
    );

    return reply.send(responseText);
  } catch (error: any) {
    const duration = Date.now() - startTime;

    // A client disconnect is not an upstream failure: no breaker verdict, but
    // the consumed attempt still gets exactly one unified abort row.
    if (error.name === "AbortError" || abortController.signal.aborted) {
      memoryLogger.info(
        "Gemini 非流式请求被取消（客户端断开）",
        "GeminiNative",
      );
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: getModelForLogging(request.body, currentModel),
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "error",
        responseTime: duration,
        errorMessage: CLIENT_ABORTED_MESSAGE,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
      });
      if (options?.auditState) {
        options.auditState.auditLogged = true;
      }
      return;
    }

    memoryLogger.error(`Gemini 原生透传失败: ${error.message}`, "GeminiNative");

    circuitBreaker.recordFailure(circuitBreakerKey, error);

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest =
      shouldLogBody && requestBody
        ? truncateRequestBody(JSON.parse(requestBody))
        : undefined;

    // A terminal row was already audited before reply.send threw into this
    // catch; never write a second one for the same request.
    if (!options?.auditState?.auditLogged) {
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: getModelForLogging(request.body, currentModel),
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "error",
        responseTime: duration,
        errorMessage: error.message,
        truncatedRequest,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
      });
    }

    const statusForRetry = (error?.statusCode ||
      error?.status ||
      500) as number;
    if (
      options?.modelResult?.canRetry &&
      options?.virtualKeyValue &&
      shouldRetrySmartRouting(statusForRetry) &&
      !reply.sent
    ) {
      try {
        const { handleNonStreamRetry } =
          await import("../proxy/retry-handler.js");
        const retried = await handleNonStreamRetry(
          request,
          reply,
          statusForRetry,
          {
            virtualKey,
            virtualKeyValue: options.virtualKeyValue,
            vkDisplay,
            modelResult: options.modelResult,
            currentModel,
            startTime,
            entrypointProtocol: "gemini",
            retryBodySnapshot: options.retryBodySnapshot,
          },
        );
        if (retried) {
          return;
        }
        memoryLogger.warn(`智能路由重试失败: 没有更多可用目标`, "Gemini");
      } catch (retryError: any) {
        memoryLogger.warn(
          `智能路由重试分发异常(已忽略): ${retryError?.message || retryError}`,
          "Gemini",
        );
      }
    }

    if (!reply.sent) {
      return reply.code(500).send({
        error: {
          message: error.message || "Gemini native proxy failed",
          type: "api_error",
          param: null,
          code: "gemini_native_error",
        },
      });
    }
  }
}

export async function handleGeminiNativeStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: ProtocolConfig,
  path: string,
  virtualKey: VirtualKey,
  providerId: string,
  startTime: number,
  vkDisplay: string,
  currentModel?: any,
  options?: GeminiNativeRequestOptions,
): Promise<void> {
  const method = request.method;
  const requestUserAgent = getRequestUserAgent(request);
  const requestIp = extractIp(request);
  const circuitBreakerKey = options?.circuitBreakerKey || providerId;

  const abortController = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
    }
  });

  // 立即劫持 Fastify 的响应控制，直接操作原始 socket
  reply.hijack();

  memoryLogger.info(
    `Gemini 原生透传 (流式): ${method} ${path} | virtual key: ${vkDisplay}`,
    "GeminiNative",
  );

  const baseForNative =
    protocolConfig.nativeBaseUrl || protocolConfig.baseUrl || "";
  const upstreamBase = baseForNative.replace(/\/+$/, "");
  if (!upstreamBase) {
    throw new Error("Gemini native baseUrl is not configured");
  }
  const upstreamPath = path.startsWith("/") ? path : "/" + path;
  const url = buildNativeUpstreamUrl(upstreamBase, upstreamPath);
  url.searchParams.set("key", protocolConfig.apiKey);
  url.searchParams.set("alt", "sse");

  const submittedModelIdentifier = protocolConfig.model;
  memoryLogger.info(
    `Gemini 上游提交: 完整URL="${url.toString().replace(/key=[^&]+/, "key=***")}" | model_identifier="${submittedModelIdentifier}"`,
    "GeminiNative",
  );

  const upstreamHeaders = buildUpstreamHeaders(
    request.headers as Record<string, string | string[] | undefined>,
    protocolConfig.apiKey,
    true,
  );

  const requestBody = JSON.stringify(request.body || {});

  let attemptTimeout: NodeJS.Timeout | null = null;
  const clearAttemptTimeout = () => {
    if (attemptTimeout) {
      clearTimeout(attemptTimeout);
      attemptTimeout = null;
    }
  };

  // 监听客户端断开连接
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      clearAttemptTimeout();
      memoryLogger.info("客户端断开连接，取消 Gemini 上游请求", "GeminiNative");
    }
  });

  const totalAttempts = Math.max(
    1,
    getGeminiEmptyRetryLimit(protocolConfig) + 1,
  );
  const shouldLogBody = shouldLogRequestBody(virtualKey);
  let finalStreamChunks: string[] = [];
  let totalBytes = 0;
  let headersSent = false;
  let success = false;
  let lastEmptyError: EmptyOutputError | null = null;
  let attemptResult: GeminiStreamAttemptResult | undefined;

  try {
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (abortController.signal.aborted) {
        break;
      }

      clearAttemptTimeout();
      const attemptStartedAt = Date.now();
      attemptTimeout = setTimeout(
        () => {
          if (!abortController.signal.aborted) {
            abortController.abort();
            memoryLogger.warn("上游请求超时 (5分钟)", "GeminiNative");
          }
        },
        5 * 60 * 1000,
      );

      const upstreamResponse = await upstreamFetch(url.toString(), {
        method,
        headers: upstreamHeaders,
        body: requestBody,
        signal: abortController.signal,
      });

      clearAttemptTimeout();

      if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
        const errorText = await upstreamResponse.text();
        memoryLogger.error(
          `Gemini 上游返回错误: ${upstreamResponse.status} | ${errorText.substring(0, 200)}`,
          "GeminiNative",
        );

        // Record the failed target against the pipeline circuit key before any
        // response write, so a retry dispatch below cannot skip accounting.
        circuitBreaker.recordFailure(
          circuitBreakerKey,
          new Error(`HTTP ${upstreamResponse.status}`),
        );

        let errorResponse;
        try {
          errorResponse = JSON.parse(errorText);
        } catch {
          errorResponse = { error: errorText };
        }

        const duration = Date.now() - startTime;
        const truncatedRequest = shouldLogBody
          ? truncateRequestBody(JSON.parse(requestBody))
          : undefined;

        logApiRequestAsync({
          virtualKey,
          providerId,
          model: getModelForLogging(request.body, currentModel),
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "error",
          responseTime: duration,
          errorMessage: `HTTP ${upstreamResponse.status}: ${errorText.substring(0, 500)}`,
          truncatedRequest,
          cacheHit: 0,
          ip: requestIp,
          userAgent: requestUserAgent,
        });
        if (options?.auditState) {
          options.auditState.auditLogged = true;
        }

        // Smart-routing retry (OpenAI parity): only safe while nothing has been
        // written to the client. The failed target was already breaker-recorded
        // and audited above; the retry re-enters the Gemini-native handlers with
        // a pristine body, never another protocol's handlers.
        if (
          options?.modelResult?.canRetry &&
          options?.virtualKeyValue &&
          shouldRetrySmartRouting(upstreamResponse.status) &&
          !headersSent &&
          !reply.raw.headersSent &&
          !reply.raw.writableEnded
        ) {
          try {
            const { handleStreamRetry } =
              await import("../proxy/retry-handler.js");
            const retried = await handleStreamRetry(
              request,
              reply,
              upstreamResponse.status,
              {
                virtualKey,
                virtualKeyValue: options.virtualKeyValue,
                vkDisplay,
                modelResult: options.modelResult,
                currentModel,
                startTime,
                entrypointProtocol: "gemini",
                retryBodySnapshot: options.retryBodySnapshot,
              },
            );
            if (retried) {
              return;
            }
            memoryLogger.warn(
              `智能路由重试(流式)失败: 没有更多可用目标`,
              "Gemini",
            );
          } catch (retryError: any) {
            memoryLogger.warn(
              `智能路由重试(流式)分发异常(已忽略): ${retryError?.message || retryError}`,
              "Gemini",
            );
          }
        }

        if (!headersSent) {
          reply.raw.writeHead(upstreamResponse.status, {
            "Content-Type": "application/json",
          });
          reply.raw.write(
            JSON.stringify({
              error: {
                message:
                  errorResponse.error?.message ||
                  errorResponse.error ||
                  errorResponse.message ||
                  "Upstream error",
                type: "upstream_error",
                param: null,
                code: `gemini_${upstreamResponse.status}`,
              },
            }),
          );
          reply.raw.end();
        } else if (!reply.raw.writableEnded) {
          const payload = {
            error: {
              message:
                errorResponse.error?.message ||
                errorResponse.error ||
                errorResponse.message ||
                "Upstream error",
              type: "upstream_error",
              param: null,
              code: `gemini_${upstreamResponse.status}`,
            },
          };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          reply.raw.end();
        }
        return;
      }

      const contentType = upstreamResponse.headers.get("content-type") || "";
      if (
        !contentType.includes("text/event-stream") &&
        !contentType.includes("application/x-ndjson")
      ) {
        const text = await upstreamResponse.text();
        const duration = Date.now() - startTime;
        const truncatedRequest = shouldLogBody
          ? truncateRequestBody(JSON.parse(requestBody))
          : undefined;

        // 2xx with a non-SSE payload is a terminal upstream success for this
        // request (passed through below); record it against the circuit key.
        circuitBreaker.recordSuccess(circuitBreakerKey);

        logApiRequestAsync({
          virtualKey,
          providerId,
          model: getModelForLogging(request.body, currentModel),
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "success",
          responseTime: duration,
          truncatedRequest,
          cacheHit: 0,
          ip: requestIp,
          userAgent: requestUserAgent,
        });
        if (options?.auditState) {
          options.auditState.auditLogged = true;
        }

        reply.raw.writeHead(200, {
          "Content-Type": contentType || "application/json",
        });
        reply.raw.write(text);
        reply.raw.end();
        return;
      }

      if (!headersSent) {
        reply.raw.writeHead(upstreamResponse.status, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        headersSent = true;
      }

      const attemptResult = await streamGeminiAttempt(
        upstreamResponse,
        reply,
        abortController.signal,
        attemptStartedAt,
      );

      if (!attemptResult.hasAssistantContent && !attemptResult.bypassGuard) {
        lastEmptyError = new EmptyOutputError(
          "Gemini native stream completed without assistant output",
          { source: "gemini", attempt, totalAttempts },
        );
        memoryLogger.warn(
          `Gemini 原生流式无实际输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
          "GeminiNative",
        );
        continue;
      }

      totalBytes = attemptResult.totalBytes;
      finalStreamChunks = attemptResult.streamChunks;
      success = true;
      break;
    }

    if (!success) {
      if (reply.raw.destroyed) {
        // Client vanished before any terminal write: unified abort row, no
        // breaker verdict and no empty-output retry for a gone client.
        logApiRequestAsync({
          virtualKey,
          providerId,
          model: getModelForLogging(request.body, currentModel),
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "error",
          responseTime: Date.now() - startTime,
          errorMessage: CLIENT_ABORTED_MESSAGE,
          cacheHit: 0,
          ip: requestIp,
          userAgent: requestUserAgent,
        });
        if (options?.auditState) {
          options.auditState.auditLogged = true;
        }
        return;
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      throw (
        lastEmptyError ||
        new EmptyOutputError(
          "Gemini native stream ended without assistant output",
          { source: "gemini", totalAttempts },
        )
      );
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }

    const duration = Date.now() - startTime;

    // Terminal success: the completed stream is a success verdict for the
    // pipeline circuit key.
    circuitBreaker.recordSuccess(circuitBreakerKey);

    memoryLogger.info(
      `Gemini 原生流式透传完成: ${duration}ms | bytes: ${totalBytes} | chunks: ${finalStreamChunks.length}`,
      "GeminiNative",
    );

    let tokenCount: any = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    for (let i = finalStreamChunks.length - 1; i >= 0; i--) {
      const lines = finalStreamChunks[i].split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.substring(6).trim();
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              const data = JSON.parse(jsonStr);
              if (data.usageMetadata) {
                tokenCount = {
                  promptTokens: data.usageMetadata.promptTokenCount || 0,
                  completionTokens:
                    data.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: data.usageMetadata.totalTokenCount || 0,
                };
                break;
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
      if (tokenCount.totalTokens > 0) break;
    }
    const truncatedRequest = shouldLogBody
      ? truncateRequestBody(JSON.parse(requestBody))
      : undefined;

    logApiRequestAsync({
      virtualKey,
      providerId,
      model: getModelForLogging(request.body, currentModel),
      tokenCount,
      status: "success",
      responseTime: duration,
      tffbMs: attemptResult?.tffbMs,
      truncatedRequest,
      cacheHit: 0,
      ip: requestIp,
      userAgent: requestUserAgent,
    });
    if (options?.auditState) {
      options.auditState.auditLogged = true;
    }
  } catch (error: any) {
    clearAttemptTimeout();
    const duration = Date.now() - startTime;

    // The stream abort signal is shared between the client-close listener and
    // the 5-minute attempt timeout, so classification uses the raw socket
    // state: only a destroyed socket means the CLIENT went away.
    if (
      isClientAbort(
        error,
        undefined,
        reply.raw.destroyed || request.raw.destroyed,
      )
    ) {
      memoryLogger.info("Gemini 流式请求被取消（客户端断开）", "GeminiNative");
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: getModelForLogging(request.body, currentModel),
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "error",
        responseTime: duration,
        errorMessage: CLIENT_ABORTED_MESSAGE,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
      });
      if (options?.auditState) {
        options.auditState.auditLogged = true;
      }
      return;
    }

    memoryLogger.error(
      `Gemini 原生流式透传失败: ${error.message}`,
      "GeminiNative",
    );

    // Terminal upstream failure (includes the final EmptyOutputError): record
    // against the pipeline circuit key before any terminal write.
    circuitBreaker.recordFailure(circuitBreakerKey, error);

    const truncatedRequest = shouldLogBody
      ? truncateRequestBody(JSON.parse(requestBody))
      : undefined;

    // A terminal row was already audited before this catch ran; never write a
    // second one for the same request.
    if (!options?.auditState?.auditLogged) {
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: getModelForLogging(request.body, currentModel),
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "error",
        responseTime: duration,
        errorMessage: error.message,
        truncatedRequest,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
      });
      if (options?.auditState) {
        options.auditState.auditLogged = true;
      }
    }
    // client. Empty-output failures have already sent SSE headers by the time
    // they surface, so the guard below keeps them on the legacy path.
    const statusForRetry = (error?.statusCode ||
      error?.status ||
      500) as number;
    if (
      options?.modelResult?.canRetry &&
      options?.virtualKeyValue &&
      shouldRetrySmartRouting(statusForRetry) &&
      !reply.raw.headersSent &&
      !reply.raw.writableEnded
    ) {
      try {
        const { handleStreamRetry } = await import("../proxy/retry-handler.js");
        const retried = await handleStreamRetry(
          request,
          reply,
          statusForRetry,
          {
            virtualKey,
            virtualKeyValue: options.virtualKeyValue,
            vkDisplay,
            modelResult: options.modelResult,
            currentModel,
            startTime,
            entrypointProtocol: "gemini",
            retryBodySnapshot: options.retryBodySnapshot,
          },
        );
        if (retried) {
          return;
        }
        memoryLogger.warn(`智能路由重试(流式)失败: 没有更多可用目标`, "Gemini");
      } catch (retryError: any) {
        memoryLogger.warn(
          `智能路由重试(流式)分发异常(已忽略): ${retryError?.message || retryError}`,
          "Gemini",
        );
      }
    }

    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "Content-Type": "application/json" });
      reply.raw.write(
        JSON.stringify({
          error: {
            message: error.message || "Gemini native stream failed",
            type: "api_error",
            param: null,
            code: "gemini_native_stream_error",
          },
        }),
      );
      reply.raw.end();
    }
  }
}

async function streamGeminiAttempt(
  upstreamResponse: Response,
  reply: FastifyReply,
  abortSignal: AbortSignal,
  upstreamRequestStartedAt: number,
): Promise<GeminiStreamAttemptResult> {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    throw new Error("无法读取上游响应流");
  }

  const decoder = new TextDecoder();
  const streamChunks = new BoundedChunkRecorder();
  const pendingChunks: string[] = [];
  let buffering = true;
  let hasAssistantContent = false;
  let bypassGuard = false;
  let parserBuffer = "";
  let totalBytes = 0;
  let tffbMs: number | undefined;
  let earlyEmptyDetectionTimeout: NodeJS.Timeout | null = null;
  const EARLY_EMPTY_DETECTION_TIMEOUT_MS = parseInt(
    process.env.GEMINI_EARLY_EMPTY_DETECTION_TIMEOUT_MS || "10000",
    10,
  );

  const writeDirect = async (chunk: string) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }
    if (!reply.raw.write(chunk)) {
      await new Promise<void>((resolve) => {
        reply.raw.once("drain", resolve);
      });
    }
  };

  const flushPendingChunks = async () => {
    if (!buffering) return;
    buffering = false;
    while (pendingChunks.length > 0) {
      const pending = pendingChunks.shift();
      if (pending) {
        await writeDirect(pending);
      }
    }
  };

  const enqueueChunk = async (chunk: string) => {
    streamChunks.record(chunk);
    if (buffering) {
      pendingChunks.push(chunk);
    } else {
      await writeDirect(chunk);
    }
  };

  const processEvent = async (rawEvent: string) => {
    const payload = extractSseDataPayload(rawEvent);
    if (!payload || payload.length === 0) {
      return;
    }
    if (payload === "[DONE]") {
      if (hasAssistantContent || bypassGuard) {
        await flushPendingChunks();
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    if (!hasAssistantContent && hasGeminiAssistantContent(parsed)) {
      hasAssistantContent = true;
      await flushPendingChunks();
    }

    if (!bypassGuard && isGeminiErrorPayload(parsed)) {
      bypassGuard = true;
      await flushPendingChunks();
    }

    if (!hasAssistantContent && !bypassGuard && !earlyEmptyDetectionTimeout) {
      earlyEmptyDetectionTimeout = setTimeout(() => {
        if (!hasAssistantContent && !bypassGuard) {
          memoryLogger.warn(
            "Gemini 流式响应在早期检测超时时间内未返回内容，提前终止并重试",
            "GeminiNative",
          );
          if (earlyEmptyDetectionTimeout) {
            clearTimeout(earlyEmptyDetectionTimeout);
            earlyEmptyDetectionTimeout = null;
          }
          reader.cancel();
        }
      }, EARLY_EMPTY_DETECTION_TIMEOUT_MS);
    }
  };

  try {
    while (true) {
      if (abortSignal.aborted) {
        reader.cancel();
        break;
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      if (reply.raw.destroyed || reply.raw.writableEnded) {
        reader.cancel();
        break;
      }

      totalBytes += value.length;
      if (tffbMs === undefined) {
        tffbMs = Date.now() - upstreamRequestStartedAt;
      }
      const chunk = decoder.decode(value, { stream: true });
      await enqueueChunk(chunk);

      parserBuffer += chunk.replace(/\r\n/g, "\n");
      let boundaryIndex = parserBuffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const eventChunk = parserBuffer.slice(0, boundaryIndex);
        parserBuffer = parserBuffer.slice(boundaryIndex + 2);
        await processEvent(eventChunk);
        boundaryIndex = parserBuffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (earlyEmptyDetectionTimeout) {
    clearTimeout(earlyEmptyDetectionTimeout);
    earlyEmptyDetectionTimeout = null;
  }

  if (parserBuffer.trim().length > 0) {
    await processEvent(parserBuffer);
  }

  return {
    streamChunks: streamChunks.chunks,
    totalBytes,
    hasAssistantContent,
    bypassGuard,
    tffbMs,
  };
}
