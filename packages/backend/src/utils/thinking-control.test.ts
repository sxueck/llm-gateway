import { describe, it, expect } from "vitest";
import { applyDisableThinking } from "./thinking-control.js";

describe("applyDisableThinking", () => {
  it("returns false for non-object bodies", () => {
    expect(applyDisableThinking(undefined, "openai")).toBe(false);
    expect(applyDisableThinking(null, "anthropic")).toBe(false);
    expect(applyDisableThinking("junk", "gemini")).toBe(false);
  });

  it("strips client-requested reasoning knobs on openai bodies", () => {
    const body: any = {
      model: "qwen-instant",
      messages: [],
      reasoning_effort: "high",
      reasoning: { effort: "high" },
      thinking: { type: "enabled" },
    };

    expect(applyDisableThinking(body, "openai")).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBe(false);
    expect(body.extra_body).toEqual({ enable_thinking: false });
  });

  it("is idempotent on already-disabled openai bodies", () => {
    const body: any = { enable_thinking: false, extra_body: { enable_thinking: false } };
    expect(applyDisableThinking(body, "openai")).toBe(false);
    expect(body.enable_thinking).toBe(false);
  });

  it("forces thinking disabled on anthropic bodies", () => {
    const body: any = { thinking: { type: "enabled", budget_tokens: 1024 } };
    expect(applyDisableThinking(body, "anthropic")).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sets thinkingBudget=0 and drops thinkingLevel on gemini bodies", () => {
    const body: any = {
      generationConfig: { thinkingConfig: { thinkingBudget: 8192, thinkingLevel: "high" } },
    };

    expect(applyDisableThinking(body, "gemini")).toBe(true);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("supports snake_case gemini spellings", () => {
    const body: any = { generation_config: { thinking_config: {} } };
    expect(applyDisableThinking(body, "gemini")).toBe(true);
    expect(body.generation_config.thinking_config).toEqual({ thinkingBudget: 0 });
  });
});
