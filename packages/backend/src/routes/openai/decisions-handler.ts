import { FastifyRequest, FastifyReply } from "fastify";
import { memoryLogger } from "../../services/logger.js";
import { runProxyPipeline } from "../proxy/pipeline.js";
import {
  makeImageGenerationProxyRequest,
  buildOpenAICompatibleUrl,
} from "../proxy/http-client.js";
import { calculateTokensIfNeeded } from "../proxy/token-calculator.js";
import {
  shouldLogRequestBody,
  getModelForLogging,
} from "../proxy/handlers/shared.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import {
  truncateRequestBody,
  truncateResponseBody,
} from "../../utils/request-logger.js";
import { requestHeaderForwardingService } from "../../services/request-header-forwarding.js";
import { extractIp } from "../../utils/ip.js";
import { getRequestUserAgent } from "../../utils/http.js";
import { normalizeUsageCounts } from "../../utils/usage-normalizer.js";
import { CLIENT_ABORTED_MESSAGE } from "../../utils/client-abort.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";

export function stripTrailingV1(baseUrl?: string): string {
  return (baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function invalidDecisionsRequest(message: string, param: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code: "invalid_decisions_request",
    },
  };
}

export function createDecisionsProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();

    const pipelineResult = await runProxyPipeline(request, reply, {
      protocol: "openai",
      handlers: {
        onManualBlock: ({ reply }) => {
          reply.code(403).send({
            error: {
              message: "Access denied: IP blocked",
              type: "access_denied",
              param: "ip",
              code: "ip_blocked",
            },
          });
        },
        onAntiBotBlock: ({ reply }) => {
          reply.code(403).send({
            error: {
              message: "Access denied: Bot detected",
              type: "access_denied",
              param: "user-agent",
              code: "bot_detected",
            },
          });
        },
        onAuthError: ({ reply, authError }) => {
          reply.code(authError.code).send(authError.body);
        },
        onModelError: ({ reply, modelError }) => {
          reply.code(modelError.code).send(modelError.body);
        },
        onProviderConfigError: ({ reply, providerConfigError }) => {
          reply.code(providerConfigError.code).send(providerConfigError.body);
        },
      },
    });
    if (!pipelineResult.ok) {
      return;
    }

    const {
      virtualKey,
      virtualKeyValue,
      providerId,
      currentModel,
      modelResult,
      configResult,
    } = pipelineResult.context;

    const body = request.body as any;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send(
          invalidDecisionsRequest("Request body must be a JSON object", "body"),
        );
    }
    if (body.state === undefined || body.state === null || body.state === "") {
      return reply
        .code(400)
        .send(
          invalidDecisionsRequest("Missing required field: state", "state"),
        );
    }
    if (
      !body.questions ||
      typeof body.questions !== "object" ||
      Array.isArray(body.questions) ||
      Object.keys(body.questions).length === 0
    ) {
      return reply
        .code(400)
        .send(
          invalidDecisionsRequest(
            "Missing required field: questions (non-empty object)",
            "questions",
          ),
        );
    }

    const { protocolConfig, path: clientPath } = configResult;
    const modelAttributes = protocolConfig.modelAttributes || {};

    let upstreamBaseUrl: string | undefined = protocolConfig.baseUrl;
    let upstreamPath = clientPath;
    if (
      typeof modelAttributes.decisions_path === "string" &&
      modelAttributes.decisions_path
    ) {
      upstreamBaseUrl = stripTrailingV1(protocolConfig.baseUrl);
      upstreamPath = modelAttributes.decisions_path;
    }
    const upstreamUrl = buildOpenAICompatibleUrl(upstreamBaseUrl, upstreamPath);

    const upstreamBody = { ...body, model: protocolConfig.model };
    const forwardedHeaders =
      requestHeaderForwardingService.buildForwardedHeaders(
        request.headers as any,
      );

    const requestIp = extractIp(request);
    const requestUserAgent = getRequestUserAgent(request);
    const vkDisplay =
      virtualKeyValue && virtualKeyValue.length > 10
        ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
        : virtualKeyValue;
    const circuitBreakerKey = modelResult?.circuitBreakerKey || providerId;

    memoryLogger.info(
      `Decisions 请求: ${request.method} ${request.url} | virtual key: ${vkDisplay} | provider: ${providerId} | model: ${protocolConfig.model} | upstream: ${upstreamUrl}`,
      "Proxy",
    );

    const abortController = new AbortController();
    // Listen on the reply socket: request.raw 'close' also fires on normal
    // body completion, which must not abort the upstream request.
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    // Exactly-one-row guard: an audit row already written inside the try block
    // must not be followed by a second one when reply.send throws into the catch.
    let auditLogged = false;

    try {
      const response = await makeImageGenerationProxyRequest(
        { ...protocolConfig, baseUrl: upstreamBaseUrl },
        upstreamPath,
        upstreamBody,
        forwardedHeaders,
        abortController.signal,
      );

      const duration = Date.now() - startTime;
      const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

      if (isSuccess) {
        circuitBreaker.recordSuccess(circuitBreakerKey);
      } else {
        circuitBreaker.recordFailure(
          circuitBreakerKey,
          new Error(`HTTP ${response.statusCode}`),
        );
      }

      const usage = (response.body as any)?.usage;
      const norm = normalizeUsageCounts(usage);
      const tokenCount = usage
        ? await calculateTokensIfNeeded(
            norm.totalTokens,
            request.body,
            response.body,
          )
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const truncatedRequest = shouldLogBody
        ? truncateRequestBody(upstreamBody)
        : undefined;
      const truncatedResponse = shouldLogBody
        ? truncateResponseBody(response.body)
        : undefined;
      const errorMessage = isSuccess
        ? undefined
        : (typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body)
          ).substring(0, 500);

      logApiRequestAsync({
        virtualKey,
        providerId: providerId!,
        model: getModelForLogging(request.body, currentModel),
        tokenCount,
        status: isSuccess ? "success" : "error",
        responseTime: duration,
        errorMessage,
        truncatedRequest,
        truncatedResponse,
        cacheHit: 0,
        cachedTokens: norm.cachedTokens,
        ip: requestIp,
        userAgent: requestUserAgent,
        piiMaskedCount: 0,
      });
      auditLogged = true;

      memoryLogger.info(
        `Decisions 请求完成: ${response.statusCode} | ${duration}ms | tokens: ${tokenCount.totalTokens}`,
        "Proxy",
      );

      reply.code(response.statusCode);
      return reply.send(response.body);
    } catch (error: any) {
      if (abortController.signal.aborted) {
        memoryLogger.info("Decisions 请求被客户端取消", "Proxy");
        // Unified abort semantics: exactly one error row, no breaker verdict.
        // If a success row was already written before reply.send threw into
        // this catch, never write a second one.
        if (auditLogged) {
          return;
        }
        logApiRequestAsync({
          virtualKey,
          providerId: providerId!,
          model: getModelForLogging(request.body, currentModel),
          tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "error",
          responseTime: Date.now() - startTime,
          errorMessage: CLIENT_ABORTED_MESSAGE,
          cacheHit: 0,
          ip: requestIp,
          userAgent: requestUserAgent,
          piiMaskedCount: 0,
        });
        auditLogged = true;
        return;
      }

      const duration = Date.now() - startTime;
      circuitBreaker.recordFailure(circuitBreakerKey, error);

      memoryLogger.error(`Decisions 请求失败: ${error?.message}`, "Proxy", {
        error: error?.stack,
      });

      if (auditLogged) {
        if (!reply.sent) {
          return reply.code(500).send({
            error: {
              message: error?.message || "Decisions proxy request failed",
              type: "internal_error",
              param: null,
              code: "proxy_error",
            },
          });
        }
        return;
      }

      const shouldLogBody = shouldLogRequestBody(virtualKey);
      logApiRequestAsync({
        virtualKey,
        providerId: providerId!,
        model: getModelForLogging(request.body, currentModel),
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: "error",
        responseTime: duration,
        errorMessage: error?.message,
        truncatedRequest: shouldLogBody
          ? truncateRequestBody(upstreamBody)
          : undefined,
        cacheHit: 0,
        ip: requestIp,
        userAgent: requestUserAgent,
        piiMaskedCount: 0,
      });

      if (!reply.sent) {
        return reply.code(500).send({
          error: {
            message: error?.message || "Decisions proxy request failed",
            type: "internal_error",
            param: null,
            code: "proxy_error",
          },
        });
      }
      return;
    }
  };
}
