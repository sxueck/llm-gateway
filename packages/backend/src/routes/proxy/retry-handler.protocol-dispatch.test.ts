import { beforeEach, expect, test, vi } from "vitest";

import { retrySmartRouting } from "./model-resolver.js";
import { buildProviderConfig } from "./provider-config-builder.js";
import { shouldRetrySmartRouting } from "./routing.js";
import {
  handleNonStreamRequest as openaiNonStream,
  handleStreamRequest as openaiStream,
} from "../openai/proxy-handler.js";
import { dispatchAnthropicRequest } from "../anthropic/proxy-handler.js";
import { dispatchGeminiRequest } from "../gemini/proxy-handler.js";
import { handleNonStreamRetry, handleStreamRetry } from "./retry-handler.js";

vi.mock("../../services/logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./model-resolver.js", () => ({
  retrySmartRouting: vi.fn(),
}));

vi.mock("./provider-config-builder.js", () => ({
  buildProviderConfig: vi.fn(),
}));

vi.mock("./routing.js", () => ({
  shouldRetrySmartRouting: vi.fn(() => true),
}));

vi.mock("../openai/proxy-handler.js", () => ({
  handleNonStreamRequest: vi.fn(),
  handleStreamRequest: vi.fn(),
  applyOpenAITargetModelMutations: vi.fn(() => ({
    modelAttributes: undefined,
    effectiveMaxCompletionTokens: undefined,
  })),
  cloneOpenAIRetryBody: vi.fn(),
}));

vi.mock("../anthropic/proxy-handler.js", () => ({
  dispatchAnthropicRequest: vi.fn(),
}));

vi.mock("../gemini/proxy-handler.js", () => ({
  dispatchGeminiRequest: vi.fn(),
}));

function mockRetryTarget(overrides: Record<string, unknown> = {}) {
  vi.mocked(retrySmartRouting).mockResolvedValue({
    provider: { name: "fallback-provider" },
    providerId: "provider-2",
    circuitBreakerKey: "provider-2::real-model-b",
    currentModel: { name: "model-b", model_identifier: "model-b" },
    excludeTargetKeys: new Set([
      "provider-1::real-model-a",
      "provider-2::real-model-b",
    ]),
    canRetry: false,
    modelId: "virtual-model-1",
    ...overrides,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldRetrySmartRouting).mockReturnValue(true);
});

test("anthropic entrypoint retries through the anthropic dispatch with a pristine body, never the OpenAI handlers", async () => {
  mockRetryTarget();
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: { protocol: "anthropic", model: "model-b" },
    path: "/v1/messages",
    vkDisplay: "vk-disp",
    isStreamRequest: false,
  } as any);

  const retryBodySnapshot = {
    model: "model-a",
    max_tokens: 4096,
    messages: [{ role: "user", content: "reach me at john.doe@example.com" }],
  };
  const request = {
    body: {
      model: "model-a",
      max_tokens: 100,
      messages: [{ role: "user", content: "PII_MASKED_1" }],
      thinking: { type: "disabled" },
    },
  } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  const handled = await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: "vk-1" },
    virtualKeyValue: "vk-value",
    vkDisplay: "vk-disp",
    modelResult: {
      provider: { name: "primary-provider" },
      providerId: "provider-1",
      circuitBreakerKey: "provider-1::real-model-a",
      excludeTargetKeys: new Set(["provider-1::real-model-a"]),
      canRetry: true,
      modelId: "virtual-model-1",
    },
    startTime: Date.now(),
    entrypointProtocol: "anthropic",
    retryBodySnapshot,
  });

  expect(handled).toBe(true);

  // Protocol-correct re-entry: Anthropic dispatch receives the retry target.
  expect(dispatchAnthropicRequest).toHaveBeenCalledTimes(1);
  expect(dispatchAnthropicRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "provider-2",
      protocolConfig: { protocol: "anthropic", model: "model-b" },
      modelResult: expect.objectContaining({
        circuitBreakerKey: "provider-2::real-model-b",
      }),
      retryBodySnapshot,
    }),
  );

  // No unsafe cross-protocol handler invocation.
  expect(openaiNonStream).not.toHaveBeenCalled();
  expect(openaiStream).not.toHaveBeenCalled();
  expect(dispatchGeminiRequest).not.toHaveBeenCalled();

  // Pristine body replay: no PII surrogate, no failed target's mutations; the
  // retry target's own model identifier is applied on the fresh clone.
  expect(request.body).toEqual({
    model: "model-b",
    max_tokens: 4096,
    messages: [{ role: "user", content: "reach me at john.doe@example.com" }],
  });
  expect(request.body).not.toBe(retryBodySnapshot);
  expect(retryBodySnapshot.model).toBe("model-a");
});

test("gemini entrypoint retries through the gemini dispatch with stream state from the rebuilt config", async () => {
  mockRetryTarget();
  vi.mocked(buildProviderConfig).mockResolvedValue({
    protocolConfig: {
      protocol: "google",
      model: "model-b",
      nativeBaseUrl: "https://upstream.test",
    },
    path: "/v1beta/models/model-b:streamGenerateContent",
    vkDisplay: "vk-disp",
    isStreamRequest: true,
  } as any);

  const request = {
    url: "/v1beta/models/model-a:streamGenerateContent?alt=sse",
    body: {
      model: "model-a",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
  } as any;
  const reply = {
    sent: false,
    raw: { headersSent: false, writableEnded: false },
  } as any;

  const handled = await handleStreamRetry(request, reply, 502, {
    virtualKey: { id: "vk-1" },
    virtualKeyValue: "vk-value",
    vkDisplay: "vk-disp",
    modelResult: {
      provider: { name: "primary-provider" },
      providerId: "provider-1",
      circuitBreakerKey: "provider-1::real-model-a",
      excludeTargetKeys: new Set(["provider-1::real-model-a"]),
      canRetry: true,
      modelId: "virtual-model-1",
    },
    startTime: Date.now(),
    entrypointProtocol: "gemini",
    retryBodySnapshot: {
      model: "model-a",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    },
  });

  expect(handled).toBe(true);

  expect(dispatchGeminiRequest).toHaveBeenCalledTimes(1);
  expect(dispatchGeminiRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "provider-2",
      isStreamRequest: true,
      protocolConfig: expect.objectContaining({ protocol: "google" }),
      modelResult: expect.objectContaining({
        circuitBreakerKey: "provider-2::real-model-b",
      }),
    }),
  );

  // No unsafe cross-protocol handler invocation.
  expect(openaiStream).not.toHaveBeenCalled();
  expect(openaiNonStream).not.toHaveBeenCalled();
  expect(dispatchAnthropicRequest).not.toHaveBeenCalled();

  // Pristine body replay with the retry target's model identifier.
  expect(request.body).toEqual({
    model: "model-b",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  });
});

test("selection returns null when the model result is not retryable", async () => {
  const request = { body: {} } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  const handled = await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: "vk-1" },
    virtualKeyValue: "vk-value",
    vkDisplay: "vk-disp",
    modelResult: { canRetry: false } as any,
    startTime: Date.now(),
    entrypointProtocol: "anthropic",
  });

  expect(handled).toBe(false);
  expect(retrySmartRouting).not.toHaveBeenCalled();
  expect(dispatchAnthropicRequest).not.toHaveBeenCalled();
  expect(openaiNonStream).not.toHaveBeenCalled();
});

test("selection returns null when the rebuilt provider config fails, without dispatching any protocol", async () => {
  mockRetryTarget();
  vi.mocked(buildProviderConfig).mockResolvedValue({
    code: 400,
    body: {
      error: {
        message: "unsupported protocol",
        type: "invalid_request_error",
        param: null,
        code: "unsupported_model_protocol",
      },
    },
  } as any);

  const request = { body: { model: "model-a" } } as any;
  const reply = { sent: false, raw: { headersSent: false } } as any;

  const handled = await handleNonStreamRetry(request, reply, 503, {
    virtualKey: { id: "vk-1" },
    virtualKeyValue: "vk-value",
    vkDisplay: "vk-disp",
    modelResult: {
      provider: { name: "primary-provider" },
      providerId: "provider-1",
      excludeTargetKeys: new Set(["provider-1::real-model-a"]),
      canRetry: true,
      modelId: "virtual-model-1",
    } as any,
    startTime: Date.now(),
    entrypointProtocol: "gemini",
  });

  expect(handled).toBe(false);
  expect(dispatchGeminiRequest).not.toHaveBeenCalled();
  expect(dispatchAnthropicRequest).not.toHaveBeenCalled();
  expect(openaiNonStream).not.toHaveBeenCalled();
});
