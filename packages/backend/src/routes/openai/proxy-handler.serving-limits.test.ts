import { beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.MYSQL_PASSWORD ??= "vitest-placeholder";
  process.env.JWT_SECRET ??= "vitest-placeholder-secret-32-chars!!";
});

vi.mock("../../services/logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { applyOpenAITargetModelMutations } from "./proxy-handler.js";
import { memoryLogger } from "../../services/logger.js";

function makeRequest(body: Record<string, unknown>) {
  return { body } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenAI serving-limit clamp at target mutation boundary", () => {
  test("clamps oversized max_tokens and max_completion_tokens to the serving cap", () => {
    const request = makeRequest({
      model: "gpt-x",
      max_tokens: 5000,
      max_completion_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    });

    const result = applyOpenAITargetModelMutations(request, {
      name: "gpt-x",
      model_attributes: JSON.stringify({ max_completion_tokens: 1024 }),
    });

    expect(request.body.max_tokens).toBe(1024);
    expect(request.body.max_completion_tokens).toBe(1024);
    expect(result.effectiveMaxCompletionTokens).toBe(1024);
    expect(memoryLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("clamped to 1024"),
      "Proxy",
    );
  });

  test("does not treat catalog max_tokens / max_output_tokens as a completion serving cap", () => {
    const request = makeRequest({
      model: "gpt-x",
      max_tokens: 5000,
      messages: [{ role: "user", content: "hi" }],
    });

    const result = applyOpenAITargetModelMutations(request, {
      name: "gpt-x",
      model_attributes: JSON.stringify({
        max_tokens: 1_000_000,
        max_output_tokens: 384_000,
        context_length: 128_000,
      }),
    });

    expect(request.body.max_tokens).toBe(5000);
    expect(result.effectiveMaxCompletionTokens).toBeUndefined();
    expect(memoryLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("clamped"),
      "Proxy",
    );
  });

  test("leaves in-cap requests unchanged", () => {
    const request = makeRequest({
      model: "gpt-x",
      max_completion_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });

    applyOpenAITargetModelMutations(request, {
      name: "gpt-x",
      model_attributes: JSON.stringify({ max_completion_tokens: 1024 }),
    });

    expect(request.body.max_completion_tokens).toBe(512);
  });
});
