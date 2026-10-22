import { describe, expect, it } from "vitest";
import {
  extractAnthropicUsage,
  extractOpenAiUsage,
  extractStreamModel,
  extractUsageFromStreamChunks,
  parseSseChunkBuffer,
  sumTokens,
} from "./playground-metrics.js";

describe("extractOpenAiUsage", () => {
  it("读取非流式 chat completions 的 usage（含 cached_tokens）", () => {
    expect(
      extractOpenAiUsage({
        model: "gpt-4o",
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      cachedTokens: 60,
      totalTokens: 140,
    });
  });

  it("兼容 responses 风格 input_tokens / input_tokens_details，缺 total 时求和", () => {
    expect(
      extractOpenAiUsage({
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 10 },
        },
      }),
    ).toEqual({
      promptTokens: 30,
      completionTokens: 12,
      cachedTokens: 10,
      totalTokens: 42,
    });
  });

  it("无 usage / usage 为空时返回 null", () => {
    expect(extractOpenAiUsage(null)).toBeNull();
    expect(extractOpenAiUsage({ choices: [] })).toBeNull();
    expect(extractOpenAiUsage({ usage: {} })).toBeNull();
    expect(
      extractOpenAiUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    ).toBeNull();
  });
});

describe("extractAnthropicUsage", () => {
  it("cache 读取计入 cachedTokens，cache_creation 不计", () => {
    // 理由：estimateUsageCost 对 cachedTokens 按 cache_read 单价计价，
    // cache_creation 是 1.25x 写入溢价，混入会低估成本；
    // input_tokens 不含 cache 部分，三项求和才是完整输入（与
    // routes/anthropic/http-client.ts 的口径一致）。
    expect(
      extractAnthropicUsage({
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 80,
        },
      }),
    ).toEqual({
      promptTokens: 330,
      completionTokens: 25,
      cachedTokens: 200,
      totalTokens: 355,
    });
  });

  it("无 cache 字段时正常汇总，缺失 usage 返回 null", () => {
    expect(
      extractAnthropicUsage({ usage: { input_tokens: 10, output_tokens: 5 } }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
    });
    expect(extractAnthropicUsage({})).toBeNull();
    expect(extractAnthropicUsage({ usage: null })).toBeNull();
  });
});

describe("sumTokens", () => {
  it("totalTokens = prompt + completion", () => {
    expect(
      sumTokens({ promptTokens: 7, completionTokens: 3 }),
    ).toBe(10);
  });
});

describe("parseSseChunkBuffer", () => {
  it("解析多帧，保留 event 与 data，兼容多行 data", () => {
    const frames = parseSseChunkBuffer(
      'data: {"a":1}\n\n: keep-alive\n\nevent: message_delta\ndata: {"b":2}\n\ndata: line1\ndata: line2\n\n',
    );
    expect(frames).toEqual([
      { event: null, data: '{"a":1}' },
      { event: "message_delta", data: '{"b":2}' },
      { event: null, data: "line1\nline2" },
    ]);
  });

  it("心跳注释行不产生帧", () => {
    expect(parseSseChunkBuffer(": ping\n\n: ping\n\n")).toEqual([]);
  });

  it("不完整尾帧被丢弃，CRLF 帧边界可解析", () => {
    expect(parseSseChunkBuffer('data: {"a":1}\n\ndata: {"trunc')).toEqual([
      { event: null, data: '{"a":1}' },
    ]);
    expect(parseSseChunkBuffer('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
  });
});

describe("extractUsageFromStreamChunks", () => {
  it("OpenAI：取最后一个带 usage 的 chunk", () => {
    const chunks = [
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"c1","choices":[]}\n\n',
      'data: {"id":"c1","usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
      "data: [DONE]\n\n",
    ];
    expect(extractUsageFromStreamChunks(chunks, "openai")).toEqual({
      promptTokens: 8,
      completionTokens: 6,
      cachedTokens: 4,
      totalTokens: 14,
    });
  });

  it("Anthropic：message_start 输入侧 + 最后 message_delta 输出侧合并", () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-5-sonnet","usage":{"input_tokens":20,"cache_read_input_tokens":100,"cache_creation_input_tokens":30,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    expect(extractUsageFromStreamChunks(chunks, "anthropic")).toEqual({
      promptTokens: 150,
      completionTokens: 42,
      cachedTokens: 100,
      totalTokens: 192,
    });
  });

  it("Anthropic GLM：开头输入为 0，末尾返回真实输入/缓存/输出（生产捕获样本）", () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"glm-5.3","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":136,"output_tokens":20,"cache_read_input_tokens":175360,"server_tool_use":{"web_search_requests":0},"service_tier":"standard"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    expect(extractUsageFromStreamChunks(chunks, "anthropic")).toEqual({
      promptTokens: 175496,
      completionTokens: 20,
      cachedTokens: 175360,
      totalTokens: 175516,
    });
  });

  it("Anthropic：末尾 usage 缺输入/缓存字段时保留开头值，重复累计事件不叠加", () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":100,"cache_creation_input_tokens":30}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":20,"output_tokens":10}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":20,"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    expect(extractUsageFromStreamChunks(chunks, "anthropic")).toEqual({
      promptTokens: 150,
      completionTokens: 42,
      cachedTokens: 100,
      totalTokens: 192,
    });
  });

  it("Anthropic：非法字段值被忽略，保留之前值", () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":100,"output_tokens":2}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":null,"output_tokens":-3,"cache_read_input_tokens":"12"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    expect(extractUsageFromStreamChunks(chunks, "anthropic")).toEqual({
      promptTokens: 120,
      completionTokens: 2,
      cachedTokens: 100,
      totalTokens: 122,
    });
  });

  it("流里没有 usage 时返回 null（上游可不回传 usage / 断流累积不完整）", () => {
    expect(
      extractUsageFromStreamChunks(
        ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"],
        "openai",
      ),
    ).toBeNull();
    expect(extractUsageFromStreamChunks([], "anthropic")).toBeNull();
    // 非 JSON 帧安全跳过
    expect(
      extractUsageFromStreamChunks(["data: not-json\n\n"], "openai"),
    ).toBeNull();
  });

  it("extractStreamModel 从流里取模型名", () => {
    expect(
      extractStreamModel(
        ['data: {"model":"gpt-4o","choices":[]}\n\n'],
        "openai",
      ),
    ).toBe("gpt-4o");
    expect(
      extractStreamModel(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-5-sonnet"}}\n\n',
        ],
        "anthropic",
      ),
    ).toBe("claude-3-5-sonnet");
    expect(extractStreamModel(["data: [DONE]\n\n"], "openai")).toBeNull();
  });
});
