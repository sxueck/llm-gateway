import { describe, expect, test } from "vitest";

import {
  anthropicPromptTokens,
  createEmptyAnthropicUsage,
  mergeAnthropicUsage,
} from "./anthropic-usage.js";

describe("mergeAnthropicUsage", () => {
  test("GLM sample: zeroed message_start merged with the final message_delta yields the real counts", () => {
    // Captured from provider zhipu-codingplan-max (glm-5.3):
    // message_start.message.usage = {"input_tokens":0,"output_tokens":0}
    let usage = mergeAnthropicUsage(
      createEmptyAnthropicUsage(),
      { input_tokens: 0, output_tokens: 0 },
    );
    // message_delta.usage (verbatim sample, extra fields included)
    usage = mergeAnthropicUsage(usage, {
      input_tokens: 136,
      output_tokens: 20,
      cache_read_input_tokens: 175360,
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard",
    });

    expect(usage).toEqual({
      inputTokens: 136,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 175360,
    });
    expect(anthropicPromptTokens(usage)).toBe(175496);
  });

  test("standard Anthropic: input/cache only in message_start, output in message_delta", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 11,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    });
    usage = mergeAnthropicUsage(usage, { output_tokens: 5 });

    expect(usage.inputTokens).toBe(11);
    expect(usage.cacheCreationInputTokens).toBe(3);
    expect(usage.cacheReadInputTokens).toBe(7);
    expect(usage.outputTokens).toBe(5);
    expect(anthropicPromptTokens(usage)).toBe(21);
  });

  test("missing trailing fields keep the values from the earlier report", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 11,
      cache_read_input_tokens: 7,
    });
    usage = mergeAnthropicUsage(usage, {});

    expect(usage.inputTokens).toBe(11);
    expect(usage.cacheReadInputTokens).toBe(7);
    expect(usage.outputTokens).toBe(0);
  });

  test("an explicit valid 0 overwrites the previous value (no truthiness shortcut)", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 11,
      cache_read_input_tokens: 7,
    });
    usage = mergeAnthropicUsage(usage, {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    });

    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadInputTokens).toBe(0);
    expect(usage.outputTokens).toBe(4);
  });

  test("cumulative reports overwrite instead of accumulating (repeated message_delta)", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 136,
      output_tokens: 5,
    });
    usage = mergeAnthropicUsage(usage, { output_tokens: 12 });
    usage = mergeAnthropicUsage(usage, { output_tokens: 20, input_tokens: 136 });

    expect(usage.outputTokens).toBe(20);
    expect(usage.inputTokens).toBe(136);
  });

  test("invalid field values (NaN, negative, wrong type) are ignored", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 7,
    });
    usage = mergeAnthropicUsage(usage, {
      input_tokens: Number.NaN,
      output_tokens: -3,
      cache_read_input_tokens: "12",
      cache_creation_input_tokens: null,
    });

    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(5);
    expect(usage.cacheReadInputTokens).toBe(7);
    expect(usage.cacheCreationInputTokens).toBe(0);
  });

  test("Infinity and fractional values are sanitized to finite integers", () => {
    const usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: Number.POSITIVE_INFINITY,
      output_tokens: 20.9,
    });

    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(20);
  });

  test("missing or non-object usage leaves the accumulated counts untouched", () => {
    let usage = mergeAnthropicUsage(createEmptyAnthropicUsage(), {
      input_tokens: 11,
      output_tokens: 5,
    });
    expect(mergeAnthropicUsage(usage, undefined)).toEqual(usage);
    expect(mergeAnthropicUsage(usage, null)).toEqual(usage);
    expect(mergeAnthropicUsage(usage, "garbage")).toEqual(usage);
    expect(mergeAnthropicUsage(usage, 42)).toEqual(usage);
  });
});
