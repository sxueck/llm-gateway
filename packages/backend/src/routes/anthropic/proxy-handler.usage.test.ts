import { beforeEach, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
});

import { dispatchAnthropicRequest } from "./proxy-handler.js";
import { circuitBreaker } from "../../services/circuit-breaker.js";
import { logApiRequestAsync } from "../../services/api-request-logger.js";
import { makeAnthropicStreamRequest } from "./http-client.js";
import { shouldRetrySmartRouting } from "../proxy/routing.js";
import { handleStreamRetry } from "../proxy/retry-handler.js";
import { CLIENT_ABORTED_MESSAGE } from "../../utils/client-abort.js";

vi.mock("../../services/logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../services/circuit-breaker.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../services/circuit-breaker.js")
  >();
  return {
    ...actual,
    circuitBreaker: { recordSuccess: vi.fn(), recordFailure: vi.fn() },
  };
});

vi.mock("../../services/api-request-logger.js", () => ({
  logApiRequestAsync: vi.fn(),
}));

// Mirrors the real priority: stream-parsed usage wins when prompt+completion > 0.
vi.mock("../proxy/token-calculator.js", () => ({
  calculateTokensIfNeeded: vi.fn(
    async (
      _total: number,
      _body: any,
      _resp?: any,
      _chunks?: string[],
      promptFromStream?: number,
      completionFromStream?: number,
    ) => {
      const prompt = promptFromStream ?? 0;
      const completion = completionFromStream ?? 0;
      return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
    },
  ),
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

vi.mock("../proxy/model-handlers.js", () => ({
  parseModelAttributes: vi.fn(() => ({})),
}));

const CIRCUIT_KEY = "provider-1::glm-real";

/** GLM zhipu-codingplan-max stream outcome for the captured sample frames. */
const GLM_STREAM_USAGE = {
  promptTokens: 175496,
  completionTokens: 20,
  totalTokens: 175516,
  cachedTokens: 175360,
  usage: {
    inputTokens: 136,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 175360,
  },
  stopReason: "tool_use",
  streamChunks: ['event: message_start\ndata: {"type":"message_start"}\n\n'],
};

function makeStreamArgs() {
  const request: any = {
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    raw: { on: vi.fn() },
    body: {
      model: "glm-5.3",
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
  const reply: any = { sent: false, header: vi.fn(), removeHeader: vi.fn(), raw };
  raw.removeHeader = vi.fn();
  return { request, reply, raw };
}

function dispatchStream() {
  const { request, reply } = makeStreamArgs();
  return dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: { id: "vk-1", key_value: "sk-ant-vitest-000001", disable_logging: 0 } as any,
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: { name: "glm-5.3", model_identifier: "glm-5.3" },
    modelResult: {
      canRetry: true,
      circuitBreakerKey: CIRCUIT_KEY,
      routeInfo: { logId: "log-1", tier: "primary" },
    },
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "glm-5.3",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(true);
});

test("GLM stream usage propagates from stream events through the audit row (input incl. cache, no double count)", async () => {
  vi.mocked(makeAnthropicStreamRequest).mockResolvedValue(GLM_STREAM_USAGE as any);

  await dispatchStream();

  expect(circuitBreaker.recordSuccess).toHaveBeenCalledWith(CIRCUIT_KEY);
  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const args = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;

  expect(args.status).toBe("success"); // tool_use completion is a normal success
  expect(args.tokenCount).toEqual({
    promptTokens: 175496,
    completionTokens: 20,
    totalTokens: 175516,
  });
  expect(args.cachedTokens).toBe(175360);
  expect(args.responseMeta).toEqual({
    finish_reason: "tool_use",
    input_tokens: 136,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 175360,
    cached_tokens: 175360,
  });
  // Usage metadata travels independently of the (bounded) response body.
  expect(args.truncatedResponse).not.toContain("175360");
});

test("client abort writes one error row without fabricating usage and no breaker verdict", async () => {
  const abortError = new DOMException("The operation was aborted", "AbortError");
  vi.mocked(makeAnthropicStreamRequest).mockRejectedValue(abortError);

  const { request, reply } = makeStreamArgs();
  // Simulate the client-close listener having aborted the upstream request:
  // the handler registers on reply.raw (ServerResponse socket close).
  reply.raw.on = vi.fn((event: string, cb: () => void) => {
    if (event === "close") cb();
  });

  await dispatchAnthropicRequest({
    request,
    reply,
    virtualKey: { id: "vk-1", key_value: "sk-ant-vitest-000001", disable_logging: 0 } as any,
    virtualKeyValue: "sk-ant-vitest-000001",
    providerId: "provider-1",
    currentModel: { name: "glm-5.3", model_identifier: "glm-5.3" },
    modelResult: { canRetry: true, circuitBreakerKey: CIRCUIT_KEY },
    startTime: Date.now() - 5,
    protocolConfig: {
      protocol: "anthropic",
      model: "glm-5.3",
      baseUrl: "https://upstream.test",
    },
    vkDisplay: "vk-disp",
  });

  expect(circuitBreaker.recordSuccess).not.toHaveBeenCalled();
  expect(circuitBreaker.recordFailure).not.toHaveBeenCalled();
  expect(vi.mocked(handleStreamRetry)).not.toHaveBeenCalled();
  expect(logApiRequestAsync).toHaveBeenCalledTimes(1);
  const args = vi.mocked(logApiRequestAsync).mock.calls[0][0] as any;
  expect(args.status).toBe("error");
  expect(args.errorMessage).toBe(CLIENT_ABORTED_MESSAGE);
  // No fabricated completion usage: no stream-derived numbers are claimed.
  expect(args.responseMeta).toBeUndefined();
  expect(args.cachedTokens).toBeUndefined();
});
