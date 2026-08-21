import { describe, expect, it } from "vitest";

import {
  clampMaxTokensFields,
  resolveServingLimits,
} from "./serving-limits.js";

describe("resolveServingLimits", () => {
  it("returns serving cap from max_completion_tokens only", () => {
    const limits = resolveServingLimits({
      max_completion_tokens: 131072,
      max_tokens: 384000, // catalog context window, NOT a serving cap
      max_output_tokens: 384000,
    });

    expect(limits).toEqual({
      contextWindow: 384000,
      maxCompletionTokens: 131072,
    });
  });

  it("resolves context window with priority context_window > context_length > max_tokens", () => {
    expect(
      resolveServingLimits({
        context_window: 1000000,
        context_length: 200000,
        max_tokens: 128000,
      }).contextWindow,
    ).toBe(1000000);
    expect(
      resolveServingLimits({ context_length: 200000, max_tokens: 128000 })
        .contextWindow,
    ).toBe(200000);
    expect(resolveServingLimits({ max_tokens: 128000 }).contextWindow).toBe(
      128000,
    );
  });

  it("ignores catalog output values as caps", () => {
    const limits = resolveServingLimits({ max_output_tokens: 262144 });

    expect(limits.maxCompletionTokens).toBeUndefined();
    expect(limits.contextWindow).toBeUndefined();
  });

  it("rejects non-positive and non-finite values", () => {
    expect(
      resolveServingLimits({
        max_completion_tokens: 0,
        max_tokens: -5,
        context_length: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
    expect(resolveServingLimits(null)).toEqual({});
    expect(resolveServingLimits("junk")).toEqual({});
  });
});

describe("clampMaxTokensFields", () => {
  it("clamps both max_tokens and max_completion_tokens to the serving cap", () => {
    const body: any = { max_tokens: 384000, max_completion_tokens: 200000 };

    expect(clampMaxTokensFields(body, 131072)).toBe(true);
    expect(body).toEqual({ max_tokens: 131072, max_completion_tokens: 131072 });
  });

  it("keeps values within the cap untouched", () => {
    const body: any = { max_tokens: 4096 };

    expect(clampMaxTokensFields(body, 131072)).toBe(false);
    expect(body.max_tokens).toBe(4096);
  });

  it("does nothing without a cap or body", () => {
    expect(clampMaxTokensFields({ max_tokens: 999999 }, undefined)).toBe(false);
    expect(clampMaxTokensFields(null, 131072)).toBe(false);
  });

  it("ignores non-number values", () => {
    const body: any = { max_tokens: "384000" };

    expect(clampMaxTokensFields(body, 131072)).toBe(false);
    expect(body.max_tokens).toBe("384000");
  });
});
