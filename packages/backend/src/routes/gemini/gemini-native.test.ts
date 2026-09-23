import { beforeEach, expect, test, vi } from "vitest";

import {
  handleGeminiNativeNonStreamRequest,
  handleGeminiNativeStreamRequest,
} from "./gemini-native.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";
import { upstreamFetch } from "../../utils/upstream-fetch.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import { shouldRetrySmartRouting } from "../proxy/routing.js";
import { handleStreamRetry } from "../proxy/retry-handler.js";

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
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
  })),
}));

vi.mock("../../utils/upstream-fetch.js", () => ({
  upstreamFetch: vi.fn(),
}));

vi.mock("../../services/request-header-forwarding.js", () => ({
  requestHeaderForwardingService: { buildForwardedHeaders: vi.fn(() => ({})) },
}));

vi.mock("../../utils/ip.js", () => ({
  extractIp: vi.fn(() => "203.0.113.7"),
}));

vi.mock("../../utils/http.js", () => ({
  getRequestUserAgent: vi.fn(() => "vitest-agent"),
}));

vi.mock("../proxy/routing.js", () => ({
  shouldRetrySmartRouting: vi.fn(() => false),
}));

vi.mock("../proxy/retry-handler.js", () => ({
  handleStreamRetry: vi.fn(),
  handleNonStreamRetry: vi.fn(),
  cloneSmartRoutingRetryBody: vi.fn((body: any) =>
    body === undefined || body === null
      ? body
      : JSON.parse(JSON.stringify(body)),
  ),
}));

const CIRCUIT_KEY = "provider-1::real-model-a";
const PROVIDER_ID = "provider-1";

function makeVirtualKey() {
  return {
    id: "vk-1",
    key_value: "sk-vitest-key-000001",
    disable_logging: 0,
  } as any;
}

function makeNonStreamReply() {
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
    raw: { on: vi.fn() },
  };
  return reply;
}

function makeNonStreamRequest() {
  return {
    method: "POST",
    url: "/v1beta/models/gemini-2.0-flash:generateContent",
    body: {
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    headers: { "content-type": "application/json" },
    raw: { on: vi.fn() },
  } as any;
}

const PROTOCOL_CONFIG = {
  provider: "provider-1",
  apiKey: "test-api-key",
  baseUrl: "https://upstream.example.test",
  nativeBaseUrl: "https://upstream.example.test",
  model: "gemini-2.0-flash",
  protocol: "google",
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

test("non-stream upstream success records circuitBreaker success against the pipeline circuit key", async () => {
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hi there" }] } }],
        usageMetadata: { totalTokenCount: 5 },
      }),
  } as any);

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  expect(circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(CIRCUIT_KEY);
  expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
  expect(reply.send).toHaveBeenCalledTimes(1);
});

test("non-stream upstream failure records circuitBreaker failure against the pipeline circuit key (not the bare provider id)", async () => {
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 503,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () =>
      JSON.stringify({ error: { message: "upstream overloaded" } }),
  } as any);

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "HTTP 503" }),
  );
  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", providerId: PROVIDER_ID }),
  );
  expect(reply.send).toHaveBeenCalledTimes(1);
});

test("non-stream retry does not copy failed target response headers", async () => {
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(true);
  const { handleNonStreamRetry } = await import("../proxy/retry-handler.js");
  vi.mocked(handleNonStreamRetry).mockResolvedValue(true);
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 429,
    headers: new Headers({ "retry-after": "60" }),
    text: async () => JSON.stringify({ error: { message: "rate limited" } }),
  } as any);

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    {
      circuitBreakerKey: CIRCUIT_KEY,
      modelResult: {
        provider: { name: "provider-1" },
        providerId: PROVIDER_ID,
        canRetry: true,
        modelId: "virtual-model-1",
        excludeTargetKeys: new Set([CIRCUIT_KEY]),
      },
      virtualKeyValue: "sk-vitest-key-000001",
    },
  );

  expect(handleNonStreamRetry).toHaveBeenCalledTimes(1);
  expect(reply.header).not.toHaveBeenCalled();
  expect(reply.code).not.toHaveBeenCalled();
});

test("non-stream network error records circuitBreaker failure and audits the failed attempt", async () => {
  vi.mocked(upstreamFetch).mockRejectedValue(new Error("socket hang up"));

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "socket hang up" }),
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "error",
      errorMessage: "socket hang up",
    }),
  );
});

function makeStreamReply() {
  const raw: any = {
    on: vi.fn(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(function (this: any) {
      this.headersSent = true;
    }),
    write: vi.fn(() => true),
    end: vi.fn(function (this: any) {
      this.writableEnded = true;
    }),
    setHeader: vi.fn(),
  };
  const reply: any = {
    sent: false,
    hijack: vi.fn(),
    raw,
  };
  return reply;
}

function makeStreamRequest() {
  return {
    method: "POST",
    url: "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    body: {
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
    headers: { "content-type": "application/json" },
    raw: { on: vi.fn() },
  } as any;
}

test("stream upstream failure records failure, audits, then dispatches a gemini-protocol retry before anything is written", async () => {
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(true);
  vi.mocked(handleStreamRetry).mockResolvedValue(true);
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 502,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ error: { message: "bad gateway" } }),
  } as any);

  const request = makeStreamRequest();
  const reply = makeStreamReply();
  const modelResult = {
    canRetry: true,
    modelId: "virtual-model-1",
    excludeTargetKeys: new Set(["provider-1::real-model-a"]),
    circuitBreakerKey: CIRCUIT_KEY,
  } as any;
  const retryBodySnapshot = {
    model: "gemini-2.0-flash",
    contents: request.body.contents,
  };

  await handleGeminiNativeStreamRequest(
    request,
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    {
      circuitBreakerKey: CIRCUIT_KEY,
      modelResult,
      virtualKeyValue: "sk-vitest-key-000001",
      retryBodySnapshot,
    },
  );

  // Breaker + audit account the failed target first…
  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "HTTP 502" }),
  );
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error" }),
  );
  // …before the retry dispatch.
  expect(handleStreamRetry).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(circuitBreaker.recordFailure).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(handleStreamRetry).mock.invocationCallOrder[0]);
  expect(
    vi.mocked(logApiRequestAsync).mock.invocationCallOrder[0],
  ).toBeLessThan(vi.mocked(handleStreamRetry).mock.invocationCallOrder[0]);

  // Retry re-enters through the Gemini protocol, with the pristine snapshot.
  expect(handleStreamRetry).toHaveBeenCalledWith(
    request,
    reply,
    502,
    expect.objectContaining({
      entrypointProtocol: "gemini",
      modelResult,
      retryBodySnapshot,
    }),
  );

  // Retry took over: nothing was written to the hijacked raw response.
  expect(reply.raw.writeHead).not.toHaveBeenCalled();
  expect(reply.raw.write).not.toHaveBeenCalled();
  expect(reply.raw.end).not.toHaveBeenCalled();
});

test("stream upstream failure without retry eligibility writes the error response and still records the failure", async () => {
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(false);
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 500,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ error: { message: "internal" } }),
  } as any);

  const reply = makeStreamReply();
  await handleGeminiNativeStreamRequest(
    makeStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    {
      circuitBreakerKey: CIRCUIT_KEY,
      modelResult: {
        provider: { name: "p" },
        providerId: PROVIDER_ID,
        canRetry: true,
        modelId: "virtual-model-1",
        excludeTargetKeys: new Set(["t1"]),
      } as any,
      virtualKeyValue: "sk-vitest-key-000001",
    },
  );

  expect(circuitBreaker.recordFailure).toHaveBeenCalledWith(
    CIRCUIT_KEY,
    expect.objectContaining({ message: "HTTP 500" }),
  );
  expect(handleStreamRetry).not.toHaveBeenCalled();
  expect(reply.raw.writeHead).toHaveBeenCalledWith(500, {
    "Content-Type": "application/json",
  });
  expect(reply.raw.end).toHaveBeenCalled();
});

test("stream success logs a defined tffbMs in the api request log", async () => {
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(false);
  const sseBody = [
    'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}',
    "",
    "",
  ].join("\n");
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    }),
  } as any);

  const reply = makeStreamReply();
  await handleGeminiNativeStreamRequest(
    makeStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(CIRCUIT_KEY);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "success",
      tffbMs: expect.any(Number),
    }),
  );
});

test("non-stream: reply.raw close before completion aborts upstream and writes exactly one Client aborted row", async () => {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  vi.mocked(upstreamFetch).mockRejectedValue(abortError);

  const reply = makeNonStreamReply();
  const handlerPromise = handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  // Simulate a real client disconnect: reply not finished writing.
  (reply.raw as any).writableEnded = false;
  const closeCb = vi
    .mocked(reply.raw.on)
    .mock.calls.find(([event]: [string, ...unknown[]]) => event === "close")?.[1] as () => void;
  closeCb();

  await handlerPromise;

  const signal = vi.mocked(upstreamFetch).mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(true);
  expect(reply.send).not.toHaveBeenCalled();
  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", errorMessage: "Client aborted" }),
  );
  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
});

test("non-stream: upstream AbortError without a client close records a breaker failure", async () => {
  const timeoutError = new Error("Upstream timed out");
  timeoutError.name = "AbortError";
  vi.mocked(upstreamFetch).mockRejectedValue(timeoutError);

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(), reply, PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent", makeVirtualKey(),
    PROVIDER_ID, Date.now() - 5, "vk-disp", { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", errorMessage: "Upstream timed out" }),
  );
});

test("non-stream: close after a completed response must NOT abort the upstream", async () => {
  vi.mocked(upstreamFetch).mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "hi there" }] } }],
      }),
  } as any);

  const reply = makeNonStreamReply();
  await handleGeminiNativeNonStreamRequest(
    makeNonStreamRequest(),
    reply,
    PROTOCOL_CONFIG,
    "/v1beta/models/gemini-2.0-flash:generateContent",
    makeVirtualKey(),
    PROVIDER_ID,
    Date.now() - 5,
    "vk-disp",
    { name: "gemini-a" },
    { circuitBreakerKey: CIRCUIT_KEY },
  );

  // Node 22 fires IncomingMessage 'close' on body completion; the reply-side
  // listener must treat a finished response as a normal end, not a disconnect.
  (reply.raw as any).writableEnded = true;
  const closeCb = vi
    .mocked(reply.raw.on)
    .mock.calls.find(([event]: [string, ...unknown[]]) => event === "close")?.[1] as () => void;
  closeCb();

  const signal = vi.mocked(upstreamFetch).mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(false);
  expect(reply.send).toHaveBeenCalledTimes(1);
  expect(logApiRequestAsync).toHaveBeenCalledWith(
    expect.objectContaining({ status: "success" }),
  );
});
