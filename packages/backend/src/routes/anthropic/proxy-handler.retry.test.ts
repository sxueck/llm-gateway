import { beforeEach, expect, test, vi } from "vitest";

import {
  applyAnthropicTargetModelMutations,
  dispatchAnthropicRequest,
  handleAnthropicNonStreamRequest,
} from "./proxy-handler.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import { makeAnthropicRequest } from "./http-client.js";
import { shouldRetrySmartRouting } from "../proxy/routing.js";
import {
  handleNonStreamRetry,
  handleStreamRetry,
} from "../proxy/retry-handler.js";

vi.mock("../../services/logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../services/circuit-breaker.js", () => ({
  circuitBreaker: { recordSuccess: vi.fn(), recordFailure: vi.fn() },
}));

vi.mock("../../services/api-request-logger.js", () => ({
  logApiRequestAsync: vi.fn(),
}));

vi.mock("../proxy/token-calculator.js", () => ({
  calculateTokensIfNeeded: vi.fn(async () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })),
}));

vi.mock("./http-client.js", () => ({
  makeAnthropicRequest: vi.fn(),
  makeAnthropicStreamRequest: vi.fn(),
}));

vi.mock("../../services/pii-protection-service.js", () => ({
  maskRequestBodyInPlace: vi.fn(() => ({
    applied: false,
    context: null,
    maskedCount: 0,
  })),
  restoreResponseBodyInPlace: vi.fn(),
}));

vi.mock("../../services/request-header-forwarding.js", () => ({
  requestHeaderForwardingService: { buildForwardedHeaders: vi.fn(() => ({})) },
}));

vi.mock("../proxy/routing.js", () => ({
  shouldRetrySmartRouting: vi.fn(() => true),
}));

vi.mock("../proxy/retry-handler.js", () => ({
  handleNonStreamRetry: vi.fn(),
  handleStreamRetry: vi.fn(),
  cloneSmartRoutingRetryBody: vi.fn((body: any) =>
    body === undefined || body === null
      ? body
      : JSON.parse(JSON.stringify(body)),
  ),
}));

vi.mock("../proxy/pipeline.js", () => ({
  runProxyPipeline: vi.fn(),
}));

vi.mock("../proxy/model-handlers.js", () => ({
  parseModelAttributes: vi.fn((raw: string | null | undefined) => {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return {};
    }
  }),
}));

const CIRCUIT_KEY = "provider-1::real-model-a";

function makeVirtualKey() {
  return {
    id: "vk-1",
    key_value: "sk-ant-vitest-000001",
    disable_logging: 0,
  } as any;
}

function makeNonStreamArgs() {
  const request: any = {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    raw: { on: vi.fn() },
    body: {
      model: "claude-target-a",
      max_tokens: 5000,
      messages: [{ role: "user", content: "hello" }],
    },
  };
  const reply: any = {
    sent: false,
    header: vi.fn(),
    code: vi.fn(function (this: any) {
      return this;
    }),
    send: vi.fn(function (this: any) {
      this.sent = true;
      return this;
    }),
    raw: { on: vi.fn(), setHeader: vi.fn() },
  };
  return { request, reply };
}

const UPSTREAM_503 = {
  statusCode: 503,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  }),
};

const MODEL_RESULT = {
  canRetry: true,
  modelId: "virtual-model-1",
  excludeTargetKeys: new Set(["provider-1::real-model-a"]),
  circuitBreakerKey: CIRCUIT_KEY,
};

const CURRENT_MODEL = {
  name: "claude-target-a",
  model_identifier: "claude-real-a",
  model_attributes: JSON.stringify({ max_completion_tokens: 1024 }),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(true);
});

test("dispatch clamps max_tokens to the target serving cap before calling the upstream", async () => {
  vi.mocked(makeAnthropicRequest).mockResolvedValue({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  } as any);

  const { request, reply } = makeNonStreamArgs();
  await dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: makeVirtualKey(),
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
    retryBodySnapshot: undefined,
  });

  expect(request.body.max_tokens).toBe(1024);
  expect(reply.header).toHaveBeenCalledWith("X-Max-Completion-Tokens", "1024");
  expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(CIRCUIT_KEY);
  expect(reply.code).toHaveBeenCalledWith(200);
});

test("retry target without a serving cap clears the prior target cap header", () => {
  const request = { body: { max_tokens: 100, messages: [] } } as any;
  const raw = { setHeader: vi.fn(), removeHeader: vi.fn() };
  const reply = { header: vi.fn(), removeHeader: vi.fn(), raw } as any;

  applyAnthropicTargetModelMutations(request, reply, CURRENT_MODEL);
  applyAnthropicTargetModelMutations(request, reply, { name: "claude-target-b" });

  expect(reply.removeHeader).toHaveBeenCalledWith("X-Max-Completion-Tokens");
  expect(raw.removeHeader).toHaveBeenCalledWith("X-Max-Completion-Tokens");
});

test("non-stream retry-eligible failure: breaker + audit account the failed target before the anthropic retry dispatch, and no error is sent", async () => {
  vi.mocked(makeAnthropicRequest).mockResolvedValue(UPSTREAM_503 as any);
  vi.mocked(handleNonStreamRetry).mockResolvedValue(true);

  const { request, reply } = makeNonStreamArgs();
  const retryBodySnapshot = {
    model: "claude-target-a",
    max_tokens: 5000,
    messages: [{ role: "user", content: "reach me at john@example.com" }],
  };

  await handleAnthropicNonStreamRequest({
    request,
    reply,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    virtualKey: makeVirtualKey(),
    providerId: "provider-1",
    circuitBreakerKey: CIRCUIT_KEY,
    startTime: Date.now() - 5,
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    virtualKeyValue: "sk-ant-vitest-000001",
    vkDisplay: "vk-disp",
    retryBodySnapshot,
  });

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "HTTP 503" }),
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error" }),
  );

  expect(handleNonStreamRetry).toHaveBeenCalledTimes(1);
  expect(handleNonStreamRetry).toHaveBeenCalledWith(
    request,
    reply,
    503,
    expect.objectContaining({
      entrypointProtocol: "anthropic",
      modelResult: MODEL_RESULT,
      retryBodySnapshot,
      virtualKeyValue: "sk-ant-vitest-000001",
    }),
  );

  // Accounting strictly precedes the retry dispatch.
  expect(
    vi.mocked(circuitBreaker.recordFailure).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(handleNonStreamRetry).mock.invocationCallOrder[0]);
  expect(
    vi.mocked(logApiRequestAsync).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(handleNonStreamRetry).mock.invocationCallOrder[0]);

  // The retry target owns the response now: upstream error is not delivered.
  expect(reply.code).not.toHaveBeenCalled();
  expect(reply.send).not.toHaveBeenCalled();
});

test("non-stream failure falls back to delivering the upstream error when no retry target is available", async () => {
  vi.mocked(makeAnthropicRequest).mockResolvedValue(UPSTREAM_503 as any);
  vi.mocked(handleNonStreamRetry).mockResolvedValue(false);

  const { request, reply } = makeNonStreamArgs();
  await handleAnthropicNonStreamRequest({
    request,
    reply,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    virtualKey: makeVirtualKey(),
    providerId: "provider-1",
    circuitBreakerKey: CIRCUIT_KEY,
    startTime: Date.now() - 5,
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    virtualKeyValue: "sk-ant-vitest-000001",
  });

  expect(handleNonStreamRetry).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(reply.code).toHaveBeenCalledWith(503);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error" }),
  );
});

test("non-stream failure outside smart routing records the breaker failure and delivers the error without retrying", async () => {
  vi.mocked(makeAnthropicRequest).mockResolvedValue(UPSTREAM_503 as any);

  const { request, reply } = makeNonStreamArgs();
  await handleAnthropicNonStreamRequest({
    request,
    reply,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    virtualKey: makeVirtualKey(),
    providerId: "provider-1",
    circuitBreakerKey: CIRCUIT_KEY,
    startTime: Date.now() - 5,
    currentModel: CURRENT_MODEL,
    modelResult: { canRetry: false },
  });

  expect(handleNonStreamRetry).not.toHaveBeenCalled();
  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "HTTP 503" }),
  );
  expect(reply.code).toHaveBeenCalledWith(503);
});

function makeStreamArgs() {
  const request: any = {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    raw: { on: vi.fn() },
    body: {
      model: "claude-target-a",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
  };
  const raw: any = {
    on: vi.fn(),
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    writeHead: vi.fn(function (this: any) {
      this.headersSent = true;
    }),
    write: vi.fn(() => true),
    end: vi.fn(function (this: any) {
      this.writableEnded = true;
    }),
  };
  const reply: any = { sent: false, header: vi.fn(), raw };
  return { request, reply, raw };
}

test("stream failure before any bytes are written retries through the anthropic protocol instead of writing the error", async () => {
  const enriched = new Error("Overloaded");
  (enriched as any).statusCode = 503;
  (enriched as any).errorResponse = {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  };
  const { makeAnthropicStreamRequest } = await import("./http-client.js");
  vi.mocked(makeAnthropicStreamRequest).mockRejectedValue(enriched);
  vi.mocked(handleStreamRetry).mockResolvedValue(true);

  const { request, reply, raw } = makeStreamArgs();
  await dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: makeVirtualKey(),
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
    retryBodySnapshot: {
      model: "claude-target-a",
      max_tokens: 100,
      stream: true,
      messages: [],
    },
  });

  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    enriched,
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error" }),
  );
  expect(handleStreamRetry).toHaveBeenCalledWith(
    request,
    reply,
    503,
    expect.objectContaining({
      entrypointProtocol: "anthropic",
      modelResult: MODEL_RESULT,
    }),
  );
  expect(
    vi.mocked(circuitBreaker.recordFailure).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(handleStreamRetry).mock.invocationCallOrder[0]);

  // Retry owns the response: the transport no longer writes errors itself.
  expect(raw.writeHead).not.toHaveBeenCalled();
  expect(raw.write).not.toHaveBeenCalled();
  expect(raw.end).not.toHaveBeenCalled();
});

test("stream failure with no remaining retry target writes the anthropic error envelope to the client", async () => {
  const enriched = new Error("Overloaded");
  (enriched as any).statusCode = 503;
  (enriched as any).errorResponse = {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  };
  const { makeAnthropicStreamRequest } = await import("./http-client.js");
  vi.mocked(makeAnthropicStreamRequest).mockRejectedValue(enriched);
  vi.mocked(handleStreamRetry).mockResolvedValue(false);

  const { request, reply, raw } = makeStreamArgs();
  await dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: makeVirtualKey(),
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
  });

  expect(handleStreamRetry).toHaveBeenCalledTimes(1);
  expect(raw.writeHead).toHaveBeenCalledWith(503, {
    "Content-Type": "application/json",
  });
  expect(raw.write).toHaveBeenCalledWith(
    `data: ${JSON.stringify((enriched as any).errorResponse)}\n\n`,
  );
  expect(raw.end).toHaveBeenCalled();
});

test("stream empty-output terminal ends the response without synthesizing an error payload", async () => {
  const { EmptyOutputError } =
    await import("../../errors/empty-output-error.js");
  const { makeAnthropicStreamRequest } = await import("./http-client.js");
  vi.mocked(makeAnthropicStreamRequest).mockRejectedValue(
    new EmptyOutputError("Anthropic stream ended without assistant output", {
      source: "claude",
      totalAttempts: 2,
    }),
  );
  vi.mocked(handleStreamRetry).mockResolvedValue(false);

  const { request, reply, raw } = makeStreamArgs();
  await dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: makeVirtualKey(),
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: CURRENT_MODEL,
    modelResult: MODEL_RESULT,
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "claude-real-a",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
  });

  // Empty output is a terminal failure for the breaker. When the response was
  // already flushed the retry guard blocks a retry; when it was untouched a
  // retry is attempted first. Either way the terminal path preserves the
  // legacy wire behavior: end the response without an error frame.
  expect(raw.end).toHaveBeenCalled();
  expect(raw.write).not.toHaveBeenCalled();
  expect(raw.writeHead).not.toHaveBeenCalled();
  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
});
