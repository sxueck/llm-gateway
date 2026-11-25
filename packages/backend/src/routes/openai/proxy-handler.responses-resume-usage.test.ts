import { beforeEach, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// config/index.ts 在模块加载期校验 env，而 vitest 不加载 .env——注入最小
// 占位值（db 入口已 mock，不产生真实连接）。
vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
});

import Fastify from "fastify";

import { createOpenAIProxyHandler } from "./proxy-handler.js";
import { runProxyPipeline } from "../proxy/pipeline.js";
import { makeStreamHttpRequest } from "../proxy/http-client.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import { memoryLogger } from "../../services/logger.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";
// 真实计费链路：calculateTokensIfNeeded → countStreamResponseTokens（tiktoken）。
// 本文件验证完整已交付核算（deliveredOutputText = clientText 全量）一路
// 流到审计/配额口径：磁带被 256KiB 录制上限截断也按完整文本真实分词计数。
import {
  countTextCooperatively,
  countTokensForText,
} from "../../services/token-counter.js";

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

const KEY_VALUE = "sk-responses-resume-usage-test-key";
const PROMPT_INPUT = "count me as prompt once";

// 完整已交付输出（clientText 全量）：均超过 256KiB（BoundedChunkRecorder
// 默认录制上限）——真实链路里磁带只会录到它们的前缀。
const ASCII_FULL_TEXT = "a".repeat(300_000);
// 用标点分隔重复的中文句子，避免单个长 BPE 片段；仍超过磁带上限。
const CJK_SENTENCE = "配额不得因磁带截断而低估。";
const CJK_FULL_TEXT = CJK_SENTENCE.repeat(24_000).slice(0, 263_000);

function frame(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function stringDelta(text: string): string {
  return frame("response.output_text.delta", { delta: text });
}

function objectDelta(text: string): string {
  return frame("response.output_text.delta", { delta: { text } });
}

/** 256KiB 录制上限截断后剩下的磁带前缀（开头的增量帧）。 */
function truncatedTape(fullText: string, extraFrames: string[] = []): string[] {
  return [
    stringDelta(fullText.slice(0, 6)),
    objectDelta(fullText.slice(6, 12)),
    ...extraFrames,
  ];
}

function synthesizedFailureFrame(message: string, fullText: string): string {
  return frame("response.failed", {
    response: {
      id: "resp_usage",
      status: "failed",
      error: { code: "server_error", message },
      output: [
        {
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: fullText }],
        },
      ],
      usage: null,
    },
  });
}

function mockPipelineResolvedResponses() {
  vi.mocked(runProxyPipeline).mockResolvedValue({
    ok: true,
    context: {
      requestIp: "127.0.0.1",
      requestUserAgent: "vitest",
      virtualKey: {
        id: "vk-responses-resume-usage",
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
        id: 9,
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
      input: PROMPT_INPUT,
    },
  });
  await vi.waitFor(() => expect(logApiRequestAsync).toHaveBeenCalledTimes(1), { timeout: 60_000 });
  await app.close();
  return { status: res.statusCode, body: res.body };
}

function mockStreamUsage(usage: Record<string, unknown>) {
  vi.mocked(makeStreamHttpRequest).mockImplementation(
    (async (_protocolConfig: any, _messages: any, _options: any, reply: any) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end("data: [DONE]\n\n");
      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        tffbMs: 12,
        ...usage,
      };
    }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPipelineResolvedResponses();
});

test("配额路径（成功续传 + ASCII 超 256KiB 磁带）：审计行 completion 按完整文本真实分词计数", async () => {
  mockStreamUsage({
    // 磁带 = 256KiB 录制上限截断后的前缀；完整核算 = clientText 全量。
    streamChunks: truncatedTape(ASCII_FULL_TEXT),
    streamResumed: true,
    streamResumeAttempts: 1,
    streamResumeChars: 7,
    deliveredOutputText: ASCII_FULL_TEXT,
  });

  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("success");

  // 完整口径：prompt（原客户端 input）一次 + 完整已交付文本的真实分词
  // 计数（不是只数被 256KiB 上限截断的磁带前缀，也不是 chars/4 估算）。
  // 这正是 virtualKeyQuota.record 消费的 tokenCount.totalTokens ——
  // 不得因磁带截断而低估配额。
  const expectedPrompt = countTokensForText(PROMPT_INPUT);
  const expectedCompletion = await countTextCooperatively(ASCII_FULL_TEXT);
  expect(entry.tokenCount.promptTokens).toBe(expectedPrompt);
  expect(entry.tokenCount.completionTokens).toBe(expectedCompletion);
  expect(entry.tokenCount.totalTokens).toBe(expectedPrompt + expectedCompletion);

  // 续传估算留痕仍在（网关估算 ≠ 上游真实用量）。
  const billingLog = vi
    .mocked(memoryLogger.info)
    .mock.calls.map((c) => String(c[0]))
    .find((m) => m.includes("断点续传计费"));
  expect(billingLog).toBeDefined();
  expect(billingLog).toContain(`completion=${expectedCompletion}`);
});

test("配额路径（合成失败续传 + 中文超 256KiB 磁带）：error 行同样按完整文本真实分词计数", async () => {
  mockStreamUsage({
    streamChunks: truncatedTape(CJK_FULL_TEXT, [
      synthesizedFailureFrame("continuation exploded", CJK_FULL_TEXT),
    ]),
    streamResumed: true,
    streamResumeAttempts: 2,
    streamResumeChars: 7,
    streamFailed: true,
    streamFailure: { code: "server_error", message: "continuation exploded" },
    deliveredOutputText: CJK_FULL_TEXT,
  });

  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("error");
  expect(entry.errorMessage).toBe("continuation exploded");

  // 失败行同样不得只依赖被截断的磁带：客户端确实收到了磁带外的文本。
  const expectedPrompt = countTokensForText(PROMPT_INPUT);
  const expectedCompletion = await countTextCooperatively(CJK_FULL_TEXT);
  expect(entry.tokenCount.promptTokens).toBe(expectedPrompt);
  expect(entry.tokenCount.completionTokens).toBe(expectedCompletion);
  expect(entry.tokenCount.totalTokens).toBe(expectedPrompt + expectedCompletion);
  // 中文场景 chars/4 会显著低估：真实分词计数必须明显大于该启发式。
  expect(expectedCompletion).toBeGreaterThan(Math.ceil(CJK_FULL_TEXT.length / 4));

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
});

test("非续传行为保留：上游 usage 优先，deliveredOutputText 不参与非续传估算", async () => {
  mockStreamUsage({
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
    // 即使链路误带了完整文本，非续传路径也不得改用磁带估算。
    streamChunks: truncatedTape(ASCII_FULL_TEXT),
    deliveredOutputText: ASCII_FULL_TEXT,
  });

  const res = await injectResponsesStream();
  expect(res.status).toBe(200);

  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const entry = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(entry.status).toBe("success");
  expect(entry.tokenCount).toEqual({
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  });
  expect(entry.streamResume).toBeUndefined();
  expect(circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
});
