import { describe, expect, it } from "vitest";

import { modelAttributesSchema } from "./models.js";

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
