import { describe, it, expect, vi, beforeEach } from "vitest";
import { HistoryCompactor, type CompactorConfig } from "./history-compactor.js";

vi.mock("../utils/upstream-fetch.js", () => ({ upstreamFetch: vi.fn() }));
vi.mock("../utils/api-endpoint-builder.js", () => ({
  buildChatCompletionsEndpoint: (baseUrl: string) =>
    `${baseUrl}/v1/chat/completions`,
}));
vi.mock("./logger.js", () => ({
  memoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { upstreamFetch } from "../utils/upstream-fetch.js";
import { countTokensForMessages } from "./token-counter.js";

// 阈值按单条消息实测 token 数推导，避免断言依赖估算器实现细节
const MSG_TOKENS = countTokensForMessages([
  { role: "user", content: "msg-sample-" + "x".repeat(400) },
]);

const fetchMock = vi.mocked(upstreamFetch);

function makeConfig(overrides: Partial<CompactorConfig> = {}): CompactorConfig {
  return {
    enabled: true,
    thresholdTokens: 300,
    keepRecent: 2,
    minDeltaTokens: MSG_TOKENS + 5,
    model: "summarizer-mini",
    baseUrl: "https://summarizer.test",
    apiKey: "sk-test",
    cacheSize: 16,
    cacheTtlMs: 30 * 60 * 1000,
    ...overrides,
  };
}

// 每条消息约 MSG_TOKENS tokens，阈值由实测值推导
function makeMessages(count: number, seed = 0): any[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (seed + i) % 2 === 0 ? "user" : "assistant",
    content: `msg-${seed + i}-` + "x".repeat(400),
  }));
}

function summaryResponse(summary: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: summary } }] }),
  };
}

describe("HistoryCompactor.compactIfNeeded", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("低于阈值时不触发", async () => {
    const compactor = new HistoryCompactor(makeConfig());
    const messages = [{ role: "user", content: "hi" }];
    const result = await compactor.compactIfNeeded(messages);
    expect(result.fired).toBe(false);
    expect(result.messages).toBe(messages);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("未配置 summarizer 上游时不触发", async () => {
    const compactor = new HistoryCompactor(makeConfig({ apiKey: "" }));
    const result = await compactor.compactIfNeeded(makeMessages(10));
    expect(result.fired).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("首次压缩：摘要替换历史并保留最近消息", async () => {
    fetchMock.mockResolvedValueOnce(summaryResponse("SUM-1") as any);
    const compactor = new HistoryCompactor(makeConfig());
    const messages = makeMessages(10);

    const result = await compactor.compactIfNeeded(messages);

    expect(result.fired).toBe(true);
    expect(result.merged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // system 为空：[summary, ...最近2条]
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[compacted summary]\nSUM-1");
    expect(result.messages.slice(1)).toEqual(messages.slice(-2));
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });

  it("小增量不重复调用 LLM：摘要 + 未合并增量原样下发", async () => {
    fetchMock.mockResolvedValueOnce(summaryResponse("SUM-1") as any);
    const compactor = new HistoryCompactor(makeConfig());
    const turn1 = makeMessages(10);
    await compactor.compactIfNeeded(turn1);

    // 增加 1 条：未合并增量仅 1 条 < minDelta
    const turn2 = [
      ...turn1,
      { role: "user", content: "new-" + "x".repeat(400) },
    ];
    const result = await compactor.compactIfNeeded(turn2);

    expect(result.fired).toBe(true);
    expect(result.merged).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // [summary(SUM-1), 未合并增量1条(msg-8，上轮最近窗口刚进入历史), ...最近2条(msg-9, new-)]
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toContain("SUM-1");
    expect(result.messages[1].content).toContain("msg-8-");
    expect(result.messages[3].content).toContain("new-");
  });

  it("增量达到 minDelta 后滚动合并进摘要", async () => {
    fetchMock
      .mockResolvedValueOnce(summaryResponse("SUM-1") as any)
      .mockResolvedValueOnce(summaryResponse("SUM-2") as any);
    const compactor = new HistoryCompactor(makeConfig());
    const turn1 = makeMessages(10);
    await compactor.compactIfNeeded(turn1);

    // 未合并增量累计到 msg8+msg9 两条（>= minDelta）触发合并
    const turn2 = [
      ...turn1,
      { role: "user", content: "new1-" + "x".repeat(400) },
      { role: "assistant", content: "new2-" + "x".repeat(400) },
    ];
    const result = await compactor.compactIfNeeded(turn2);

    expect(result.fired).toBe(true);
    expect(result.merged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // [summary(SUM-2), ...最近2条]
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toContain("SUM-2");
    expect(result.messages[0].content).not.toContain("new1-");
  });

  it("同桶分叉会话不互相挤掉摘要缓存", async () => {
    fetchMock
      .mockResolvedValueOnce(summaryResponse("SUM-A") as any)
      .mockResolvedValueOnce(summaryResponse("SUM-B") as any);
    const compactor = new HistoryCompactor(makeConfig());
    // A 与 B 共享前 8 条消息（同桶），其后分叉
    const a1 = makeMessages(20);
    await compactor.compactIfNeeded(a1);
    const b1 = [...makeMessages(8), ...makeMessages(12, 500)];
    await compactor.compactIfNeeded(b1);

    // A 下一轮应复用自己的 SUM-A，而不是被 B 的重建挤掉后重新摘要
    const a2 = [...a1, { role: "user", content: "next-" + "x".repeat(400) }];
    const result = await compactor.compactIfNeeded(a2);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.merged).toBe(false);
    expect(result.messages[0].content).toContain("SUM-A");
  });

  it("summarizer 用量随结果上抛，复用缓存时不产生", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "SUM-U" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 80 },
      }),
    } as any);
    const compactor = new HistoryCompactor(makeConfig());
    const fired = await compactor.compactIfNeeded(makeMessages(10));
    expect(fired.summarizerTokens).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
    });

    // 小增量复用缓存：无 summarizer 用量
    const reused = await compactor.compactIfNeeded([
      ...makeMessages(10),
      { role: "user", content: "new-" + "x".repeat(400) },
    ]);
    expect(reused.summarizerTokens).toBeUndefined();
  });

  it("客户端编辑历史导致前缀失配时重建摘要", async () => {
    fetchMock
      .mockResolvedValueOnce(summaryResponse("SUM-1") as any)
      .mockResolvedValueOnce(summaryResponse("SUM-NEW") as any);
    const compactor = new HistoryCompactor(makeConfig());
    const turn1 = makeMessages(10);
    await compactor.compactIfNeeded(turn1);

    const edited = [
      { role: "user", content: "rewritten-" + "x".repeat(400) },
      ...turn1.slice(1),
    ];
    const result = await compactor.compactIfNeeded(edited);

    expect(result.merged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.messages[0].content).toContain("SUM-NEW");
  });

  it("system 消息原样保留在最前", async () => {
    fetchMock.mockResolvedValueOnce(summaryResponse("SUM-1") as any);
    const compactor = new HistoryCompactor(makeConfig());
    const system = { role: "system", content: "s".repeat(4000) };
    const messages = [system, ...makeMessages(10)];

    const result = await compactor.compactIfNeeded(messages);

    expect(result.fired).toBe(true);
    expect(result.messages[0]).toEqual(system);
    expect(result.messages).toHaveLength(4);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
  });
});
