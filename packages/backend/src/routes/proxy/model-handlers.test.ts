import { describe, expect, it } from "vitest";

import {
  applyServingLimits,
  buildModelBaseInfo,
  mergeModelAttributes,
  parseModelAttributes,
} from "./model-handlers.js";

describe("mergeModelAttributes", () => {
  it("filters internal transport attributes from client-facing entries", () => {
    const base = buildModelBaseInfo({
      is_virtual: 0,
      model_identifier: "kimi-k2.7-code",
      created_at: 1780322410000,
    });

    const merged = mergeModelAttributes(
      base,
      parseModelAttributes(
        JSON.stringify({
          headers: { "User-Agent": "RooCode/3.46.2" },
          timeout: 60000,
          maxRetries: 2,
          requestTimeout: 30000,
          upstream_websocket_enabled: true,
          max_completion_tokens: 131072,
        }),
      ),
    );

    expect(merged).toEqual({
      id: "kimi-k2.7-code",
      object: "model",
      created: 1780322410,
      owned_by: "system",
      max_completion_tokens: 131072,
    });
  });
});

describe("applyServingLimits", () => {
  it("advertises serving limits as top-level fields", () => {
    const entry = applyServingLimits(
      {
        id: "deepseek-v4-flash",
        object: "model",
        created: 1780322410,
        owned_by: "system",
      },
      { max_completion_tokens: 131072, context_window: 1000000 },
    );

    expect(entry).toEqual({
      id: "deepseek-v4-flash",
      object: "model",
      created: 1780322410,
      owned_by: "system",
      context_window: 1000000,
      max_completion_tokens: 131072,
    });
  });

  it("falls back to catalog context_length / max_tokens for the window", () => {
    const entry = applyServingLimits({ id: "m" }, { context_length: 128000 });
    expect(entry.context_window).toBe(128000);

    const viaMaxTokens = applyServingLimits(
      { id: "m" },
      { max_tokens: 1000000 },
    );
    expect(viaMaxTokens.context_window).toBe(1000000);
  });

  it("never advertises catalog output values as the completion cap", () => {
    const entry = applyServingLimits(
      { id: "deepseek-v4-pro" },
      { max_tokens: 1000000, max_output_tokens: 384000 },
    );

    expect(entry.max_completion_tokens).toBeUndefined();
    expect(entry.context_window).toBe(1000000);
  });
});
