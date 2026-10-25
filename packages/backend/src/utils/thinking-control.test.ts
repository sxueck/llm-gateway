import { describe, it, expect } from "vitest";
import { applyDisableThinking } from "./thinking-control.js";

describe("applyDisableThinking", () => {
  it("returns false for non-object bodies", () => {
    expect(applyDisableThinking(undefined, "openai")).toBe(false);
    expect(applyDisableThinking(null, "anthropic")).toBe(false);
    expect(applyDisableThinking("junk", "gemini")).toBe(false);
  });

  it("forces every OpenAI off switch the upstream actually reads", () => {
    const body: any = {
      model: "mimo-v2.5-pro",
      messages: [],
      reasoning_effort: "high",
      reasoning: { effort: "high", summary: "auto" },
      thinking: { type: "enabled" },
      enable_thinking: true,
      extra_body: { enable_thinking: true },
      chat_template_kwargs: { enable_thinking: true },
    };

    expect(applyDisableThinking(body, "openai")).toBe(true);
    expect(body.reasoning_effort).toBe("none");
    expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.enable_thinking).toBe(false);
    expect(body.extra_body.enable_thinking).toBe(false);
    expect(body.chat_template_kwargs.enable_thinking).toBe(false);
  });

  it("is idempotent on already-disabled openai bodies", () => {
    const body: any = {
      reasoning_effort: "none",
      reasoning: { effort: "none" },
      thinking: { type: "disabled" },
      enable_thinking: false,
    };
    expect(applyDisableThinking(body, "openai")).toBe(false);
    expect(body).toEqual({
      reasoning_effort: "none",
      reasoning: { effort: "none" },
      thinking: { type: "disabled" },
      enable_thinking: false,
    });
  });

  it("forces thinking disabled on anthropic bodies", () => {
    const body: any = { thinking: { type: "enabled", budget_tokens: 1024 } };
    expect(applyDisableThinking(body, "anthropic")).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sets thinkingLevel=low and drops budget fields on gemini bodies", () => {
    const body: any = {
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 8192,
          thinkingLevel: "high",
          thinking_budget: 8192,
          thinking_level: "high",
        },
      },
      generation_config: {
        thinking_config: { thinking_budget: 4096, thinking_level: "high" },
      },
    };

    expect(applyDisableThinking(body, "gemini")).toBe(true);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(body.generation_config.thinking_config).toEqual({ thinkingLevel: "low" });
  });

  it("supports snake_case gemini spellings", () => {
    const body: any = { generation_config: { thinking_config: {} } };
    expect(applyDisableThinking(body, "gemini")).toBe(true);
    expect(body.generation_config.thinking_config).toEqual({ thinkingLevel: "low" });
  });
});
