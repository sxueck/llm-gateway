import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_BUDGET_TIERS } from "@llm-gateway/shared";
import {
  checkContextBudget,
  resetBudgetStates,
} from "./context-budget.js";
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

describe("checkContextBudget", () => {
  afterEach(() => {
    resetBudgetStates();
    vi.restoreAllMocks();
  });

  it("blocks an over-budget boundary request with the error envelope", async () => {
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
})
// ---------------------------------------------------------------------------
// Anthropic Messages 协议
// ---------------------------------------------------------------------------

function anthropicBoundaryHistory(chars: number): any[] {
  return [
    { role: "user", content: [{ type: "text", text: "read the reference document" }] },
    { role: "assistant", content: [{ type: "text", text: "x".repeat(chars) }] },
    { role: "user", content: [{ type: "text", text: "what is the key takeaway" }] },
  ];
}

describe("checkContextBudget (anthropic)", () => {
  afterEach(() => {
    resetBudgetStates();
    vi.restoreAllMocks();
  });

  it("blocks an over-budget boundary request with the Anthropic envelope pi detects", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-anthropic",
      protocol: "anthropic",
      messages: anthropicBoundaryHistory(10),
      messagesTokens: 450_000,
      budgetTokens: 400_000,
    });
    expect(verdict.action).toBe("block");
    const body = (verdict as any).body;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    // pi 的识别规则作为断言：/prompt (?:is )?too long/i 必须命中。
    expect(body.error.message).toMatch(/^prompt is too long: 450000 tokens > 400000 maximum$/);
  });

  it("counts the top-level system and tool_use/tool_result blocks toward the budget", async () => {
    const longResult = "The quick brown fox jumps over the lazy dog. ".repeat(2_200);
    const messages = [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "cat big.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: longResult }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-anthropic-2",
      protocol: "anthropic",
      messages,
      system: [{ type: "text", text: "You are a coding agent harness." }],
      budgetTokens: 5_000,
    });
    expect(verdict.action).toBe("block");
    // 大 tool_result（~24K tokens）真实入账，远超 5K 预算与角色开销。
    expect(verdict.estimatedTokens).toBeGreaterThan(10_000);
  });

  it("counts replayed thinking text so the tier cannot be bypassed", async () => {
    // 客户端会把 assistant thinking 原样回传；漏计时整块内容只按角色开销计费，
    // 预算档位对 thinking 占主的会话形同不存在。
    const thinking = "Reasoning about which file to read and why. ".repeat(4_000);
    const messages = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking, signature: "sig-1" },
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-anthropic-think",
      protocol: "anthropic",
      messages,
      budgetTokens: 20_000,
      contextWindow: 200_000,
    });
    expect(verdict.classification).toBe("boundary");
    expect(verdict.action).toBe("block");
    expect(verdict.estimatedTokens).toBeGreaterThan(30_000);
  });

  it("exempts an oversized compaction request via the system signature", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-anthropic-3",
      protocol: "anthropic",
      messages: anthropicBoundaryHistory(10),
      system: "You are a context summarization assistant. Summarize the conversation.",
      messagesTokens: 450_000,
      budgetTokens: 400_000,
    });
    expect(verdict.action).toBe("exempt");
    expect(verdict.classification).toBe("compaction");
  });
})
// ---------------------------------------------------------------------------
// OpenAI Responses 协议（/v1/responses）
// ---------------------------------------------------------------------------

function responsesBoundaryHistory(outputChars: number): any[] {
  return [
    {
      role: "developer",
      content: [{ type: "input_text", text: "You are a coding agent harness." }],
    },
    { role: "user", content: [{ type: "input_text", text: "read the reference document" }] },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "locate the file first" }],
      content: [{ type: "reasoning_text", text: "thinking about which file to read" }],
    },
    {
      type: "function_call",
      call_id: "c1",
      name: "read_file",
      arguments: JSON.stringify({ path: "docs/big.md" }),
    },
    {
      type: "function_call_output",
      call_id: "c1",
      output: "x".repeat(outputChars),
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done reading" }],
    },
    { role: "user", content: [{ type: "input_text", text: "what is the key takeaway" }] },
  ];
}

describe("checkContextBudget (responses)", () => {
  afterEach(() => {
    resetBudgetStates();
    vi.restoreAllMocks();
  });

  it("blocks an over-budget boundary request with the OpenAI overflow text and param=input", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-responses",
      protocol: "responses",
      input: responsesBoundaryHistory(40_000),
      budgetTokens: 5_000,
    });
    expect(verdict.action).toBe("block");
    const error = (verdict as any).body.error;
    // 与 Chat 分支相同的可识别措辞，param 指向 Responses 的 input 字段。
    expect(error.code).toBe("context_length_exceeded");
    expect(error.type).toBe("invalid_request_error");
    expect(error.param).toBe("input");
    expect(error.message).toMatch(
      /maximum context length is 5000 tokens\. However, your messages resulted in \d+ tokens\./,
    );
  });

  it("blocks when tool definitions alone exceed the budget", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-responses-tools",
      protocol: "responses",
      input: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          name: "bash",
          description: "read the file and summarize the results. ".repeat(4_000),
          parameters: {},
        },
      ],
      budgetTokens: 2_000,
    });
    expect(verdict.action).toBe("block");
  });

  it("passes an over-budget continuation with a warning", async () => {
    const warn = vi.spyOn(memoryLogger, "warn").mockImplementation(() => {});
    const input = [
      { role: "user", content: "run tests" },
      { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "x".repeat(40_000) },
    ];
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-responses-2",
      protocol: "responses",
      input,
      budgetTokens: 5_000,
    });
    expect(verdict.action).toBe("pass");
    expect(verdict.classification).toBe("continuation");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("exempts an oversized compaction request via the instructions signature", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-responses-3",
      protocol: "responses",
      input: responsesBoundaryHistory(40_000),
      instructions: "You are a context summarization assistant.",
      budgetTokens: 5_000,
    });
    expect(verdict.action).toBe("exempt");
    expect(verdict.classification).toBe("compaction");
  });

  it("passes requests whose history lives in upstream conversation state", async () => {
    const verdict = await checkContextBudget({
      virtualKeyId: "vk-responses-4",
      protocol: "responses",
      input: responsesBoundaryHistory(40_000),
      hasUpstreamConversationState: true,
      budgetTokens: 5_000,
    });
    // 上游持有历史，网关无法核对转发输入：不拦截（unknown 放行）。
    expect(verdict.action).toBe("pass");
    expect(verdict.classification).toBe("unknown");
  });
})