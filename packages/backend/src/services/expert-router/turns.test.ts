import { describe, expect, test } from "vitest";
import { isContinuationTurn } from "./turns.js";

describe("isContinuationTurn", () => {
  test("OpenAI trailing tool role is a continuation", () => {
    expect(
      isContinuationTurn({
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "ls" } }] },
          { role: "tool", tool_call_id: "1", content: "file-a\nfile-b" },
        ],
      }),
    ).toBe(true);
  });

  test("trailing assistant message is a continuation (prefill/resume)", () => {
    expect(
      isContinuationTurn({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "here is " },
        ],
      }),
    ).toBe(true);
  });

  test("Anthropic user message with only tool_result blocks is a continuation", () => {
    expect(
      isContinuationTurn({
        messages: [
          { role: "user", content: "read config" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
      }),
    ).toBe(true);
  });

  test("user message mixing text and tool_result is NOT a continuation", () => {
    expect(
      isContinuationTurn({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
              { type: "text", text: "now summarize" },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  test("Responses API trailing function_call_output is a continuation", () => {
    expect(
      isContinuationTurn({
        input: [
          { type: "message", role: "user", content: "go" },
          { type: "function_call", call_id: "c1", name: "ls" },
          { type: "function_call_output", call_id: "c1", output: "[]" },
        ],
      }),
    ).toBe(true);
  });

  test("Gemini trailing model turn is a continuation", () => {
    expect(
      isContinuationTurn({
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
      }),
    ).toBe(true);
  });

  test("a fresh user turn is not a continuation", () => {
    expect(
      isContinuationTurn({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "refactor this module" },
        ],
      }),
    ).toBe(false);
    expect(isContinuationTurn({ input: "just a string" })).toBe(false);
    expect(isContinuationTurn(null)).toBe(false);
    expect(isContinuationTurn({})).toBe(false);
  });
});
