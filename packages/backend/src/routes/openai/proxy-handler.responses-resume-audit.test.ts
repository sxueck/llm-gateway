import { beforeEach, expect, test, vi } from "vitest";

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
});

import Fastify from "fastify";

import {
  createOpenAIProxyHandler,
  detectResponsesResumeFailure,
} from "./proxy-handler.js";
import { runProxyPipeline } from "../proxy/pipeline.js";
import { makeStreamHttpRequest } from "../proxy/http-client.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";

vi.mock("../../services/logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    getLogs: vi.fn(() => []),
  },
}));

vi.mock("../../db/index.js", () => ({
  apiRequestDb: { create: vi.fn(async () => {}) },
}));

vi.mock("../proxy/pipeline.js", () => ({
  runProxyPipeline: vi.fn(),
}));

vi.mock("../../services/context-normalization/index.js", () => ({
  applyContextNormalization: vi.fn(async () => ({ blocked: false })),
}));

vi.mock("../proxy/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../proxy/http-client.js")>();
  return {
    ...actual,
    makeHttpRequest: vi.fn(),
    makeStreamHttpRequest: vi.fn(),
  };
});

vi.mock("../proxy/token-calculator.js", () => ({
  calculateTokensIfNeeded: vi.fn(async () => ({
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
  })),
}));

vi.mock("../../services/api-request-logger.js", () => ({
  logApiRequestAsync: vi.fn(),
}));

vi.mock("../../services/circuit-breaker.js", () => ({
  circuitBreaker: {
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  },
  httpFailureError: vi.fn(),
}));

vi.mock("../proxy/handlers/shared.js", () => ({
  shouldLogRequestBody: vi.fn(() => false),
  getModelForLogging: vi.fn((body: any) => body?.model || "unknown"),
}));

vi.mock("../../services/request-header-forwarding.js", () => ({
  requestHeaderForwardingService: {
    buildForwardedHeaders: vi.fn(() => undefined),
  },
}));

const KEY_VALUE = "sk-responses-resume-audit-test-key";

/** SSE 帧：与处理器 serializeChunkToSse 相同的 event+data 形状。 */
function frame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function stringDelta(text: string): string {
  return frame("response.output_text.delta", { delta: text });
}

function objectDelta(text: string): string {
  return frame("response.output_text.delta", { delta: { text } });
}

function synthesizedFailureFrame(stitchedText: string, message: string): string {
  return frame("response.failed", {
    response: {
      id: "resp_e2e",
      status: "failed",
      error: { code: "server_error", message },
      output: [
        { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: stitchedText }] },
      ],
      usage: null,
    },
  });
}

/** 续写成功磁带：增量 + 合成 completed 终态（携带全文）。 */
function completedTape(): string[] {
  return [
    stringDelta("E2E "),
    objectDelta("responses ok"),
    frame("response.completed", {
      response: {
        id: "resp_e2e",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "E2E responses ok" }] }],
        usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
      },
    }),
  ];
}

/** 续写失败磁带：增量 + 处理器合成的 response.failed 终态（携带全文与错误）。 */
function failedTape(): string[] {
  return [
    stringDelta("E2E "),
    objectDelta("doomed tail"),
    synthesizedFailureFrame("E2E doomed tail", "e2e continuation upstream exploded"),
  ];
}

function mockPipelineResolvedResponses() {
  vi.mocked(runProxyPipeline).mockResolvedValue({
    ok: true,
    context: {
      requestIp: "127.0.0.1",
      requestUserAgent: "vitest",
      virtualKey: {
        id: "vk-responses-resume-audit",
        key_value: KEY_VALUE,
        enabled: 1,
        cache_enabled: 0,
        context_budget_tokens: 0,
        pii_protection_enabled: 0,
      },
      virtualKeyValue: KEY_VALUE,
      provider: { name: "TestProvider" },
      providerId: "provider-1",
      currentModel: {
        id: 7,
        name: "Test Model",
        model_identifier: "test-model",
      },
      modelResult: { circuitBreakerKey: "cb-key", canRetry: false },
      configResult: {
        protocolConfig: {
          provider: "test",
          apiKey: "sk-upstream",
          baseUrl: "https://upstream.test",
          model: "test-model",
          protocol: "openai",
        },
        path: "/v1/responses",
        vkDisplay: "sk-res...-key",
        isStreamRequest: true,
      },
    },
  } as any);
}

async function injectResponsesStream(): Promise<{ status: number; body: string }> {
  const app = Fastify();
  app.post("/v1/responses", createOpenAIProxyHandler());
  const res = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: `Bearer ${KEY_VALUE}` },
    payload: {
      model: "test-model",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "resume audit probe" }] }],
    },
  });
  await app.close();
  return { status: res.statusCode, body: res.body };
}

/** 处理器对续写流的成功返回形状（usage 一律置零 + 续写事实字段）。 */
function resumedTokenUsage(streamChunks: string[], extra: Record<string, unknown> = {}) {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    streamChunks,
    tffbMs: 12,
    streamResumed: true,
    streamResumeAttempts: 1,
    streamResumeChars: 4,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPipelineResolvedResponses();
  vi.mocked(makeStreamHttpRequest).mockImplementation(
    (async (_protocolConfig: any, _messages: any, _options: any, reply: any) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end("data: [DONE]\n\n");
      return resumedTokenUsage(completedTape());
    }) as any,
  );
});

// ── 信号契约（detectResponsesResumeFailure）───────────────────────────────

test("chunk-tape 回退信号：已续写磁带中的 response.failed 终态帧被识别并取出错误文案", () => {
  const signal = detectResponsesResumeFailure(resumedTokenUsage(failedTape()));
  expect(signal).toEqual({
    message: "e2e continuation upstream exploded",
    source: "chunk-tape",
  });
});

test("处理器显式信号（已接线契约）：streamFailed 优先于磁带扫描", () => {
  // 处理器（responses-stream-processor.ts）在续写段失败、合成 response.failed
  // 终态后按成功返回时，携带 streamFailed=true + streamFailure={code,message}。
  // proxy 优先采用该显式信号；chunk 磁带扫描只是无信号链路的回退。
  const signal = detectResponsesResumeFailure(
    resumedTokenUsage(completedTape(), {
      streamFailed: true,
      streamFailure: { code: "server_error", message: "wired by processor" },
    }),
  );
  expect(signal).toEqual({ message: "wired by processor", source: "processor" });

  // 缺省文案兜底
  const fallback = detectResponsesResumeFailure(
    resumedTokenUsage(completedTape(), { streamFailed: true }),
  );
  expect(fallback).toMatchObject({ source: "processor" });
  expect(fallback!.message.length).toBeGreaterThan(0);
});

test("非续写流或续写成功磁带不产生失败信号", () => {
  // 续写成功：磁带只有合成 completed 终态
  expect(detectResponsesResumeFailure(resumedTokenUsage(completedTape()))).toBeNull();
  // 未续写的流即使磁带里有 response.failed 也不属于本信号的范围
  //（原始流的失败终态由错误路径审计，见处理器 catch 分支）。
  expect(
    detectResponsesResumeFailure({
      streamResumed: false,
      streamChunks: failedTape(),
    }),
  ).toBeNull();
  expect(detectResponsesResumeFailure({ streamResumed: true, streamChunks: [] })).toBeNull();
});

// ── 审计接线（handleStreamRequest 成功路径内的续写失败分支）───────────────

test("续写段合成失败终态：审计写 error 行（含错误文案与续写事实），记熔断失败，不写 success", async () => {
  vi.mocked(makeStreamHttpRequest).mockImplementation(
    (async (_protocolConfig: any, _messages: any, _options: any, reply: any) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end("data: [DONE]\n\n");
      return resumedTokenUsage(failedTape());
    }) as any,
  );

  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("error");
  expect(entry.errorMessage).toBe("e2e continuation upstream exploded");
  // 续写事实随失败行落库，供与上游 journal 对账
  expect(entry.streamResume).toEqual({ attempts: 1, chars: 4 });
  // 失败行也按诚实口径计费（原 prompt 一次 + 已交付增量）
  expect(entry.tokenCount).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
});

test("续写成功（合成 completed 终态）：照常写 success 行并记熔断成功", async () => {
  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("success");
  expect(entry.errorMessage).toBeUndefined();
  expect(entry.streamResume).toEqual({ attempts: 1, chars: 4 });

  expect(circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
});

test("处理器显式失败信号（已接线）：streamFailed=true 时无需磁带帧即写 error 行", async () => {
  vi.mocked(makeStreamHttpRequest).mockImplementation(
    (async (_protocolConfig: any, _messages: any, _options: any, reply: any) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end("data: [DONE]\n\n");
      return resumedTokenUsage(completedTape(), {
        streamFailed: true,
        streamFailure: { code: "server_error", message: "processor-wired resume failure" },
      });
    }) as any,
  );

  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("error");
  expect(entry.errorMessage).toBe("processor-wired resume failure");
  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
});
