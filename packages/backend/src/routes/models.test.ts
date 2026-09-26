import { describe, expect, it } from "vitest";

import { modelAttributesSchema, resolveTestProbeProtocol } from "./models.js";

describe("resolveTestProbeProtocol", () => {
  const multiProtocol = { supported_protocols: '["openai","anthropic"]' };

  it("falls back to the first supported protocol when none is requested", () => {
    expect(resolveTestProbeProtocol(multiProtocol, undefined)).toBe("openai");
  });

  it("honours an explicit protocol that belongs to supportedProtocols", () => {
    expect(resolveTestProbeProtocol(multiProtocol, "anthropic")).toBe(
      "anthropic",
    );
  });

  it("rejects a protocol outside supportedProtocols", () => {
    expect(resolveTestProbeProtocol(multiProtocol, "google")).toBeNull();
  });

  it("defaults to openai when the model has no protocol list", () => {
    expect(resolveTestProbeProtocol({ supported_protocols: null })).toBe(
      "openai",
    );
  });
});

describe("modelAttributesSchema", () => {
  it("preserves capability metadata from upstream /v1/models entries", () => {
    const result = modelAttributesSchema.parse({
      max_tokens: 8192,
      max_completion_tokens: 16384,
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      context_length: 128000,
      limit: 4096,
      supports_vision: true,
      supports_prompt_caching: false,
      supports_function_calling: true,
    });

    expect(result).toEqual({
      max_tokens: 8192,
      max_completion_tokens: 16384,
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      context_length: 128000,
      limit: 4096,
      supports_vision: true,
      supports_prompt_caching: false,
      supports_function_calling: true,
    });
  });

  it("preserves disable_thinking toggle", () => {
    const result = modelAttributesSchema.parse({ disable_thinking: true });

    expect(result).toEqual({ disable_thinking: true });
  });

  it("still strips unknown keys", () => {
    const result = modelAttributesSchema.parse({
      max_tokens: 8192,
      owned_by: "system",
      random_junk: "dropped",
    } as any);

    expect(result).toEqual({ max_tokens: 8192 });
  });

  it("maps deprecated provider alias to litellm_provider", () => {
    const result = modelAttributesSchema.parse({ provider: "openai" });

    expect(result).toEqual({ litellm_provider: "openai" });
  });

  it("passes undefined through", () => {
    expect(modelAttributesSchema.parse(undefined)).toBeUndefined();
  });
});
