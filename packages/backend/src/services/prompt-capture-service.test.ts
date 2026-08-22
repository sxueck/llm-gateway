import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturePromptSample } from "./prompt-capture-service.js";
import { promptSampleDb } from "../db/index.js";

vi.mock("../db/index.js", () => ({
  promptSampleDb: {
    create: vi.fn(),
  },
}));

vi.mock("./expert-router/preprocess/index.js", () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(),
  },
}));

describe("capturePromptSample", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not persist samples when prompt capture is disabled", async () => {
    await capturePromptSample(
      { id: "vk-1", prompt_capture_enabled: 0 } as any,
      {
        body: { messages: [{ role: "user", content: "hello" }] },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("persists the cleaned user prompt with capture metadata", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: "Explain this error",
      stats: { promptTokens: 4, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [{ role: "user", content: "Explain this error" }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        virtual_key_id: "vk-1",
        model: "gpt-5",
        protocol: "openai",
        intent_text: "Explain this error",
        prompt_tokens: 4,
        intent_truncated: 0,
      }),
    );
  });

  it("masks Gemini prompt text before persisting when PII protection is enabled", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    let capturedBody: any;
    vi.mocked(SignalBuilder.buildRoutingSignal).mockImplementation(
      async (request: any) => {
        capturedBody = request.body;
        return {
          intentText: request.body.contents[0].parts[0].text,
          stats: { promptTokens: 4, intentTruncated: false },
        } as any;
      },
    );

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 1,
      } as any,
      {
        body: {
          contents: [
            { role: "user", parts: [{ text: "Contact alice@example.com" }] },
          ],
        },
      } as any,
      "gemini",
    );

    expect(capturedBody.contents[0].parts[0].text).not.toContain(
      "alice@example.com",
    );
    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: expect.not.stringContaining("alice@example.com"),
      }),
    );
  });

  it("does not persist samples without user intent", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: "   ",
      stats: { promptTokens: 0, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: { messages: [{ role: "user", content: "hello" }] },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("strips assistant turns when client pastes full conversation into a single user message", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const mixedConversation = [
      "User: 帮我看看这段代码",
      "Assistant: 这段代码有 bug，建议这样改……",
      "User: 还是报错，怎么办？",
    ].join("\n");
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: mixedConversation,
      stats: { promptTokens: 12, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [{ role: "user", content: mixedConversation }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: "还是报错，怎么办？",
      }),
    );
  });

  it("keeps the original intent when a single-turn prompt has no assistant turns", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const singleTurn = "请用 TypeScript 实现一个 LRU 缓存";
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: singleTurn,
      stats: { promptTokens: 8, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [{ role: "user", content: singleTurn }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: singleTurn,
      }),
    );
  });

  it("keeps a leading instruction that quotes an assistant exchange", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const quotedConversation = [
      "我该怎么回复下面这段对话？",
      "Assistant: 我需要帮助",
      "User: 帮什么？",
    ].join("\n");
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: quotedConversation,
      stats: { promptTokens: 12, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [{ role: "user", content: quotedConversation }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: quotedConversation,
      }),
    );
  });

  it("skips capture for follow-up turns carrying assistant history", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [
            { role: "user", content: "帮我编写一个清理脚本" },
            { role: "assistant", content: "好的，先确认目录……" },
            { role: "user", content: "继续" },
          ],
        },
      } as any,
      "openai",
    );

    expect(SignalBuilder.buildRoutingSignal).not.toHaveBeenCalled();
    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("skips capture for agent loop turns with tool results", async () => {
    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [
            { role: "user", content: "帮我编写一个清理脚本" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function" }],
            },
            { role: "tool", tool_call_id: "call_1", content: "done" },
          ],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("skips capture when an anthropic user message carries tool_result blocks", async () => {
    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "claude-sonnet-4",
          messages: [
            { role: "user", content: "帮我编写一个清理脚本" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu_1",
                  name: "run_shell_command",
                  input: {},
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
              ],
            },
          ],
        },
      } as any,
      "anthropic",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("skips capture for gemini requests with model turns or function parts", async () => {
    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          contents: [
            { role: "user", parts: [{ text: "帮我编写一个清理脚本" }] },
            {
              role: "model",
              parts: [{ functionCall: { name: "run_shell_command" } }],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: { name: "run_shell_command", response: {} },
                },
              ],
            },
          ],
        },
      } as any,
      "gemini",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("skips capture for responses api input with tool output items", async () => {
    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          input: [
            { role: "user", content: "帮我编写一个清理脚本" },
            { type: "function_call", name: "run_shell_command", call_id: "c1" },
            { type: "function_call_output", call_id: "c1", output: "done" },
          ],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("captures responses api first-turn string input", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: "帮我编写一个清理脚本",
      stats: { promptTokens: 6, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: { model: "gpt-5", input: "帮我编写一个清理脚本" },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: "帮我编写一个清理脚本",
      }),
    );
  });

  it("extracts the reason from an orchestrator context JSON", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const orchestratorJson = JSON.stringify({
      task: "The orchestrator executed this command for the reason given below. Observe the command's output and ensure the command has exited before reporting the relevant output.\n\nReason:\nRerun training prep after User-Agent 403 fix\n\nExpected duration: 1800.0 seconds",
      active_command:
        "export LLM_API_KEY='vk_secret_key'\npython prepare_training_once.py",
      current_output_frame: "+ python gen_llm_augmentation.py\ngeneration plan: {...}",
    });
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: orchestratorJson,
      stats: { promptTokens: 936, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "grok-4.6-medium",
          messages: [{ role: "user", content: orchestratorJson }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: "Rerun training prep after User-Agent 403 fix",
      }),
    );
    // 命令与密钥绝不能入库。
    const persisted = vi.mocked(promptSampleDb.create).mock
      .calls[0][0] as { intent_text: string };
    expect(persisted.intent_text).not.toContain("vk_secret_key");
    expect(persisted.intent_text).not.toContain("current_output_frame");
    expect(persisted.intent_text).not.toContain("active_command");
  });

  it("falls back to the task text when the orchestrator context has no reason", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const orchestratorJson = JSON.stringify({
      task: "Run the weekly report generation script",
      active_command: "python gen_report.py",
      current_output_frame: "",
    });
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: orchestratorJson,
      stats: { promptTokens: 10, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "grok-4.6-medium",
          messages: [{ role: "user", content: orchestratorJson }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: "Run the weekly report generation script",
      }),
    );
  });

  it("skips capture when the orchestrator context has no extractable intent", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const orchestratorJson = JSON.stringify({
      task: "The orchestrator executed this command for the reason given below.",
      active_command: "echo hi",
      current_output_frame: "> hi",
    });
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: orchestratorJson,
      stats: { promptTokens: 8, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "grok-4.6-medium",
          messages: [{ role: "user", content: orchestratorJson }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it("keeps non-orchestrator JSON prompts unchanged", async () => {
    const { SignalBuilder } = await import(
      "./expert-router/preprocess/index.js"
    );
    const customJson = JSON.stringify({
      request: "帮我写一个清理脚本",
      tag: "demo",
    });
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: customJson,
      stats: { promptTokens: 6, intentTruncated: false },
    } as any);

    await capturePromptSample(
      {
        id: "vk-1",
        prompt_capture_enabled: 1,
        pii_protection_enabled: 0,
      } as any,
      {
        body: {
          model: "gpt-5",
          messages: [{ role: "user", content: customJson }],
        },
      } as any,
      "openai",
    );

    expect(promptSampleDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_text: customJson,
      }),
    );
  });
});
