import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_BUDGET_TIERS } from "@llm-gateway/shared";
import {
  checkContextBudget,
  classifyChatRequest,
  effectiveBudgetTokens,
  estimateForwardedInputTokens,
  resetBudgetStates,
} from "./context-budget.js";
import { countMessagesCooperatively } from "./token-counter.js";
import { memoryLogger } from "./logger.js";

function boundaryHistory(userChars: number): any[] {
  return [
    { role: "system", content: "You are a coding agent harness." },
    { role: "user", content: "read the reference document" },
    { role: "assistant", content: "x".repeat(userChars) },
    { role: "user", content: "what is the key takeaway" },
  ];
}

function assistantToolCalls(...ids: string[]): any {
  return {
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      function: { name: "bash", arguments: "{}" },
    })),
  };
}

describe("classifyChatRequest", () => {
  it("classifies a fresh user message as boundary", () => {
    expect(
      classifyChatRequest([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ]),
    ).toBe("boundary");
    expect(classifyChatRequest(boundaryHistory(10))).toBe("boundary");
  });

  it("classifies tool-result feedback as continuation", () => {
    const messages = [
      { role: "user", content: "run tests" },
      assistantToolCalls("t1"),
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ];
    expect(classifyChatRequest(messages)).toBe("continuation");
  });

  it("keeps the turn open while tool_calls are unanswered", () => {
    const messages = [
      { role: "user", content: "run tests" },
      assistantToolCalls("t1"),
      { role: "user", content: "继续执行" },
    ];
    expect(classifyChatRequest(messages)).toBe("continuation");
  });

  it("treats a new user message after answered tool calls as boundary", () => {
    const messages = [
      { role: "user", content: "run tests" },
      assistantToolCalls("t1"),
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "user", content: "next task" },
    ];
    expect(classifyChatRequest(messages)).toBe("boundary");
  });

  it("keeps the turn open while only some tool calls are answered", () => {
    const messages = [
      { role: "user", content: "run tests" },
      assistantToolCalls("t1", "t2"),
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "user", content: "continue" },
    ];
    expect(classifyChatRequest(messages)).toBe("continuation");
  });

  it("treats an assistant-tailed payload as continuation", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(classifyChatRequest(messages)).toBe("continuation");
  });

  it("detects pi compaction signature in system message", () => {
    const messages = [
      {
        role: "system",
        content:
          "You are a context summarization assistant. Read the conversation and summarize.",
      },
      { role: "user", content: "<serialized history>" },
    ];
    expect(classifyChatRequest(messages)).toBe("compaction");
  });

  it("detects opencode compaction signature in the first user message", () => {
    const messages = [
      { role: "user", content: "You are a context summarization agent.\n<history/>" },
      { role: "user", content: "history payload" },
    ];
    expect(classifyChatRequest(messages)).toBe("compaction");
  });

  it("returns unknown for empty payloads", () => {
    expect(classifyChatRequest([])).toBe("unknown");
    expect(classifyChatRequest(null as any)).toBe("unknown");
  });
});

describe("estimateForwardedInputTokens", () => {
  it("uses the shared tokenizer so CJK history is not underestimated", async () => {
    const messages = [
      { role: "user", content: "你好世界，这是用于上下文预算验证的中文历史。".repeat(1000) },
    ];
    const estimate = await estimateForwardedInputTokens(messages);
    // chars/4 只会给出 ~5500；中文的真实分词密度远高于此，预算必须按真实分词拦截。
    expect(estimate).toBe(await countMessagesCooperatively(messages));
    expect(estimate).toBeGreaterThan(10_000);
  });

  it("counts serialized tool definitions into the estimate", async () => {
    const messages = [{ role: "user", content: "hi" }];
    const tools = [
      {
        type: "function",
        function: {
          name: "bash",
          description: "read the file and summarize the results. ".repeat(4000),
          parameters: {},
        },
      },
    ];
    const withoutTools = await estimateForwardedInputTokens(messages);
    const withTools = await estimateForwardedInputTokens(messages, tools);
    expect(withTools).toBeGreaterThan(withoutTools + 5000);
  });
});

describe("effectiveBudgetTokens", () => {
  it("clamps to the model window minus the output reserve", () => {
    expect(effectiveBudgetTokens(600_000, 256_000)).toBe(256_000 - 16_384);
  });

  it("keeps the configured tier when the window is unknown or tiny", () => {
    expect(effectiveBudgetTokens(400_000, undefined)).toBe(400_000);
    expect(effectiveBudgetTokens(400_000, 8_000)).toBe(400_000);
  });
});

describe("checkContextBudget", () => {
  afterEach(() => {
    resetBudgetStates();
    vi.restoreAllMocks();
  });

  it("blocks an over-budget boundary request with the §5.1 error envelope", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-1",
      messages: boundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
    });
    expect(verdict.action).toBe("block");
    const error = (verdict as any).body.error;
    // pi / opencode 识别规则作为断言：code 字段 + 消息文本都必须命中。
    expect(error.code).toBe("context_length_exceeded");
    expect(error.type).toBe("invalid_request_error");
    expect(error.param).toBe("messages");
    expect(error.message).toMatch(
      /maximum context length is 400000 tokens\. However, your messages resulted in \d+ tokens\./,
    );
  });

  it("blocks a boundary request whose tools alone exceed the budget", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-tools-only",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "read the file and summarize the results. ".repeat(40_000),
            parameters: {},
          },
        },
      ],
      budgetTokens: 200_000,
    });
    expect(verdict.action).toBe("block");
  });

  it("reports the effective (clamped) budget in the message", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-2",
      messages: boundaryHistory(10),
      messagesTokens: 500_000,
      budgetTokens: 600_000,
      contextWindow: 256_000,
    });
    expect(verdict.action).toBe("block");
    expect((verdict as any).body.error.message).toContain(
      `maximum context length is ${256_000 - 16_384} tokens`,
    );
  });

  it("passes a within-budget boundary request", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-3",
      messages: boundaryHistory(10),
      messagesTokens: 1000,
      budgetTokens: CONTEXT_BUDGET_TIERS[0],
    });
    expect(verdict.action).toBe("pass");
  });

  it("blocks a CJK-heavy boundary request counted with the real tokenizer", async () => {
    // chars/4 会把这条 480K 字符的历史估成 ~120K，200K 档位下被错误放行；
    // 回归断言：真实分词下必须拦截。
    const messages = [{ role: "user", content: "上下文预算测试。".repeat(60_000) }];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-cjk",
      messages,
      budgetTokens: 200_000,
    });
    expect(verdict.action).toBe("block");
  });

  it("exempts compaction requests regardless of size", async () => {
    const messages = [
      { role: "system", content: "You are a context summarization assistant." },
      { role: "user", content: "h".repeat(400_000 * 4) },
    ];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-4",
      messages,
      budgetTokens: 400_000,
    });
    expect(verdict.action).toBe("exempt");
    expect(verdict.classification).toBe("compaction");
  });

  it("passes over-budget continuation requests with a warning", async () => {
    const warn = vi.spyOn(memoryLogger, "warn").mockImplementation(() => {});
    const messages = [
      { role: "user", content: "run tests" },
      assistantToolCalls("t1"),
      { role: "tool", tool_call_id: "t1", content: "ok" },
    ];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-5",
      messages,
      messagesTokens: 450_000,
      budgetTokens: 400_000,
    });
    expect(verdict.action).toBe("pass");
    expect(verdict.classification).toBe("continuation");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("graces the requests right after a rejection, then blocks again", async () => {
    let clock = 1_000_000;
    const input = {
      virtualKeyId: "vk-6",
      messages: boundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
      now: () => clock,
    };

    expect((await checkContextBudget(input)).action).toBe("block");
    // 宽限窗口内的两个请求（签名失配的压缩请求 / 重试）豁免。
    expect((await checkContextBudget(input)).action).toBe("exempt");
    expect((await checkContextBudget(input)).action).toBe("exempt");
    expect((await checkContextBudget(input)).action).toBe("block");
  });

  it("expires the grace window", async () => {
    let clock = 1_000_000;
    const input = {
      virtualKeyId: "vk-7",
      messages: boundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
      now: () => clock,
    };
    expect((await checkContextBudget(input)).action).toBe("block");
    clock += 121_000;
    expect((await checkContextBudget(input)).action).toBe("block");
  });

  it("alerts on a compaction loop (3 rejections within 10 minutes)", async () => {
    const warn = vi.spyOn(memoryLogger, "warn").mockImplementation(() => {});
    // 间隔必须大于宽限窗口（120s）：宽限内的重试会被豁免，只有宽限过后
    // 仍持续的边界拦截才计入循环。
    let clock = 1_000_000;
    const input = {
      virtualKeyId: "vk-8",
      messages: boundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
      now: () => clock,
    };
    await checkContextBudget(input);
    clock += 130_000;
    await checkContextBudget(input);
    clock += 130_000;
    await checkContextBudget(input);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("压缩循环告警"),
      "Proxy",
    );
  });

  it("does not share state across virtual keys", async () => {
    const input = (id: string) => ({
      virtualKeyId: id,
      messages: boundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
      now: () => 1_000_000,
    });
    expect((await checkContextBudget(input("vk-a"))).action).toBe("block");
    expect((await checkContextBudget(input("vk-b"))).action).toBe("block");
    // vk-b 的拦截不动用 vk-a 的宽限名额：vk-a 仍有 2 次宽限。
    expect((await checkContextBudget(input("vk-a"))).action).toBe("exempt");
    expect((await checkContextBudget(input("vk-a"))).action).toBe("exempt");
    expect((await checkContextBudget(input("vk-a"))).action).toBe("block");
  });
});
