import { test, expect, vi } from 'vitest';

// Keep the resume helper import side-effect free in tests (no real DB pool).
vi.mock('../db/index.js', () => ({
  systemConfigDb: { get: vi.fn(async () => undefined) },
}));

import { processOpenAIChatCompletionStreamToSse } from './stream-processor.js';

function createReplyStub() {
  const written: string[] = [];
  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: (_status: number, _headers: any) => {
      raw.headersSent = true;
    },
    write: (chunk: any) => {
      written.push(String(chunk));
      return true;
    },
    end: () => {
      raw.writableEnded = true;
    },
    once: (_evt: string, _cb: any) => {},
  };
  return { raw, written };
}

async function* mockChatStream(): AsyncIterable<any> {
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
  };
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
  yield {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

test('skipUsageChunks=true: usage-only chunk suppressed, usage still extracted', async () => {
  const { raw, written } = createReplyStub();

  const result = await processOpenAIChatCompletionStreamToSse({
    reply: { raw } as any,
    stream: mockChatStream(),
    model: 'gpt-4',
    skipUsageChunks: true,
  });

  expect(result.promptTokens).toBe(10);
  expect(result.completionTokens).toBe(5);
  expect(result.totalTokens).toBe(15);

  const allWrites = written.join('');
  expect(allWrites).toContain('"Hello"');
  expect(allWrites).toContain('"finish_reason":"stop"');
  expect(allWrites).toContain('data: [DONE]');
  expect(allWrites).not.toContain('"prompt_tokens":10');
});

test('skipUsageChunks=false (default): usage-only chunk forwarded downstream', async () => {
  const { raw, written } = createReplyStub();

  const result = await processOpenAIChatCompletionStreamToSse({
    reply: { raw } as any,
    stream: mockChatStream(),
    model: 'gpt-4',
  });

  expect(result.promptTokens).toBe(10);

  const allWrites = written.join('');
  expect(allWrites).toContain('"prompt_tokens":10');
});

function textChunk(id: string, content: string): any {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

function roleChunk(id: string): any {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  };
}

function finishChunk(id: string, usage: any): any {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  };
}

async function* healthyStream(chunks: any[]): AsyncIterable<any> {
  for (const c of chunks) yield c;
}

async function* brokenStream(
  chunks: any[],
  message = "upstream connection reset",
): AsyncIterable<any> {
  for (const c of chunks) yield c;
  throw new Error(message);
}

function createFakeReply() {
  const frames: string[] = [];
  const raw = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: (data: string) => {
      frames.push(data);
      return true;
    },
    end: vi.fn(),
    once: vi.fn(),
  };
  return { reply: { raw } as any, frames };
}

test("resumes once after mid-stream failure and stitches the continuation", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () =>
    healthyStream([
      roleChunk("id2"),
      textChunk("id2", "ld!"),
      finishChunk("id2", {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
      }),
    ]),
  );

  const usage = await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "Hel"), textChunk("id1", "lo wor")]),
    model: "test-model",
    resumeStreamFactory: factory,
  });

  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith("Hello wor");

  const dataFrames = frames.filter((f) => f.startsWith("data: {"));
  expect(dataFrames).toHaveLength(4); // 2 attempt-1 chunks + continuation text + finish (role chunk dropped)
  expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
  expect(dataFrames.every((f) => f.includes('"id":"id1"'))).toBe(true);
  expect(dataFrames.some((f) => f.includes("ld!"))).toBe(true);
  expect(reply.raw.end).toHaveBeenCalledTimes(1);

  expect(usage.streamResumed).toBe(true);
  expect(usage.streamResumeAttempts).toBe(1);
  expect(usage.streamResumeChars).toBe("Hello wor".length);
  expect(usage.promptTokens).toBe(0);
  expect(usage.completionTokens).toBe(0);
  expect(usage.totalTokens).toBe(0);
});

test("healthy stream passes through untouched, factory never called", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () => null);

  const usage = await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: healthyStream([
      textChunk("id1", "hi"),
      finishChunk("id1", {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      }),
    ]),
    model: "test-model",
    resumeStreamFactory: factory,
  });

  expect(factory).not.toHaveBeenCalled();
  expect(usage.streamResumed).toBe(false);
  expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
});

test("factory returning null keeps the failure terminal", async () => {
  const { reply, frames } = createFakeReply();

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "partial")]),
      model: "test-model",
      resumeStreamFactory: async () => null,
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(frames.some((f) => f === "data: [DONE]\n\n")).toBe(false);
  expect(reply.raw.end).not.toHaveBeenCalled();
});

test("tool-call fragments already flushed: no resume", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => healthyStream([textChunk("id2", "x")]));

  const toolChunk = {
    ...textChunk("id1", "about to call "),
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { name: "f", arguments: '{"a' } }],
        },
        finish_reason: null,
      },
    ],
  };

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "text "), toolChunk]),
      model: "test-model",
      resumeStreamFactory: factory,
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).not.toHaveBeenCalled();
});

test("no text flushed before failure: no resume", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => healthyStream([textChunk("id2", "x")]));

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([], "died before first token"),
      model: "test-model",
      resumeStreamFactory: factory,
    }),
  ).rejects.toThrow("died before first token");

  expect(factory).not.toHaveBeenCalled();
});

test("second failure after resume is terminal: exactly one resume attempt", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () =>
    brokenStream([textChunk("id2", "more")], "second failure"),
  );

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "first ")]),
      model: "test-model",
      resumeStreamFactory: factory,
    }),
  ).rejects.toThrow("second failure");

  expect(factory).toHaveBeenCalledTimes(1);
  expect(frames.some((f) => f.includes("more"))).toBe(true);
  expect(frames.some((f) => f === "data: [DONE]\n\n")).toBe(false);
});

test("client abort never resumes", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => healthyStream([textChunk("id2", "x")]));

  async function* abortingStream(): AsyncIterable<any> {
    yield textChunk("id1", "some text ");
    throw Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
  }

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: abortingStream(),
      model: "test-model",
      resumeStreamFactory: factory,
    }),
  ).rejects.toThrow("aborted");

  expect(factory).not.toHaveBeenCalled();
});

test("does not resume after a reasoning fragment", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => healthyStream([textChunk("id2", "x")]));
  const reasoningChunk = {
    ...textChunk("id1", "visible"),
    choices: [
      {
        index: 0,
        delta: { reasoning_content: "internal", content: "visible" },
        finish_reason: null,
      },
    ],
  };

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([reasoningChunk]),
      model: "test-model",
      resumeStreamFactory: factory,
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).not.toHaveBeenCalled();
});

test("removes role from a continuation chunk that also has content", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () =>
    healthyStream([
      {
        ...textChunk("id2", " world"),
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: " world" },
            finish_reason: null,
          },
        ],
      },
      finishChunk("id2", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
    ]),
  );

  await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "hello")]),
    model: "test-model",
    resumeStreamFactory: factory,
  });

  const continuation = frames.find((frame) => frame.includes(" world"));
  expect(continuation).toContain('"content":" world"');
  expect(continuation).not.toContain('"role":"assistant"');
});

;

test("a stream that ends after content without finish_reason is a truncation error", async () => {
  const { raw, written } = createReplyStub();

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply: { raw } as any,
      stream: healthyStream([textChunk("id1", "partial")]),
      model: "test-model",
    }),
  ).rejects.toMatchObject({ name: "StreamTruncatedError", status: 502 });

  expect(written.join("")).not.toContain("data: [DONE]");
  expect(raw.writableEnded).toBe(false);
});

test("a truncated stream is continued through the resume factory", async () => {
  const { raw, written } = createReplyStub();
  const factory = vi.fn(async () =>
    healthyStream([
      textChunk("id2", " end"),
      finishChunk("id2", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]),
  );

  const usage = await processOpenAIChatCompletionStreamToSse({
    reply: { raw } as any,
    stream: healthyStream([textChunk("id1", "start")]),
    model: "test-model",
    resumeStreamFactory: factory,
  });

  expect(factory).toHaveBeenCalledWith("start");
  expect(usage.streamResumed).toBe(true);
  expect(written.join("")).toContain("data: [DONE]");
});

test("continuation request rejected with Retry-After: waits it out, heartbeats, then retries and stitches", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi
    .fn()
    .mockResolvedValueOnce({ stream: null, retryable: true, retryAfterMs: 40 })
    .mockResolvedValueOnce(
      healthyStream([
        textChunk("id2", "ld!"),
        finishChunk("id2", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
      ]),
    );

  const startedAt = Date.now();
  const usage = await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "Hel"), textChunk("id1", "lo wor")]),
    model: "test-model",
    resumeStreamFactory: factory,
    resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 5 },
  });
  const elapsedMs = Date.now() - startedAt;

  expect(factory).toHaveBeenCalledTimes(2);
  expect(usage.streamResumed).toBe(true);
  // streamResumeAttempts = 上游续写请求创建次数：被 429 拒绝的那次 + 重试
  // 成功的那次（初始请求不计）。
  expect(usage.streamResumeAttempts).toBe(2);
  expect(usage.streamResumeChars).toBe("Hello wor".length);
  // Retry-After (40ms) 真的被遵守，而不是立即重试。
  expect(elapsedMs).toBeGreaterThanOrEqual(35);

  const heartbeatIdx = frames.findIndex((f) => f === ": ping\n\n");
  const continuationIdx = frames.findIndex((f) => f.includes("ld!"));
  expect(heartbeatIdx).toBeGreaterThan(-1);
  expect(continuationIdx).toBeGreaterThan(heartbeatIdx);
  expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
  // 心跳是注释帧，不能混入用于 token 计数/重放的 chunk 序列。
  expect(usage.streamChunks.every((c) => !c.startsWith(":"))).toBe(true);
});

test("retryable rejection without Retry-After falls back to the small default backoff", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi
    .fn()
    .mockResolvedValueOnce({ stream: null, retryable: true })
    .mockResolvedValueOnce(
      healthyStream([
        textChunk("id2", "more"),
        finishChunk("id2", { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }),
      ]),
    );

  const usage = await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "first ")]),
    model: "test-model",
    resumeStreamFactory: factory,
    resumeRetry: { heartbeatIntervalMs: 5, defaultBackoffMs: 20 },
  });

  expect(factory).toHaveBeenCalledTimes(2);
  expect(usage.streamResumed).toBe(true);
  // 创建次数口径：第一次（无 Retry-After，回退默认退避）+ 第二次成功。
  expect(usage.streamResumeAttempts).toBe(2);
  expect(frames.join("")).toContain(": ping\n\n");
  expect(frames.some((f) => f.includes("more"))).toBe(true);
});

test("retryable rejection without Retry-After and heartbeats disabled still resumes", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi
    .fn()
    .mockResolvedValueOnce({ stream: null, retryable: true })
    .mockResolvedValueOnce(
      healthyStream([
        textChunk("id2", "tail"),
        finishChunk("id2", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      ]),
    );

  const usage = await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "head")]),
    model: "test-model",
    resumeStreamFactory: factory,
    resumeRetry: { heartbeatIntervalMs: 0, defaultBackoffMs: 5 },
  });

  expect(factory).toHaveBeenCalledTimes(2);
  expect(usage.streamResumed).toBe(true);
  // 心跳关闭不影响创建计数：两次创建都被计入。
  expect(usage.streamResumeAttempts).toBe(2);
  expect(frames.some((f) => f === ": ping\n\n")).toBe(false);
});

test("heartbeats span the gap while the continuation request itself is pending", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () => {
    // create() 在拿到响应头之前悬置一段时间（覆盖 enabled 检查 + 建连）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    return healthyStream([
      textChunk("id2", "late"),
      finishChunk("id2", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
  });

  await processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "early ")]),
    model: "test-model",
    resumeStreamFactory: factory,
    resumeRetry: { heartbeatIntervalMs: 15 },
  });

  const heartbeatIdx = frames.findIndex((f) => f === ": ping\n\n");
  const continuationIdx = frames.findIndex((f) => f.includes("late"));
  expect(heartbeatIdx).toBeGreaterThan(-1);
  expect(continuationIdx).toBeGreaterThan(heartbeatIdx);
});

test("non-retryable continuation rejection stays terminal without a retry wait", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi
    .fn()
    .mockResolvedValueOnce({ stream: null, retryable: false, retryAfterMs: 5000 });

  const startedAt = Date.now();
  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "partial")]),
      model: "test-model",
      resumeStreamFactory: factory,
      resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 10 },
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).toHaveBeenCalledTimes(1);
  expect(Date.now() - startedAt).toBeLessThan(2000); // 没有盲目等 5 秒
  expect(frames.some((f) => f === "data: [DONE]\n\n")).toBe(false);
  expect(reply.raw.end).not.toHaveBeenCalled();
});

test("a Retry-After beyond the resume window terminates rather than retrying early", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => ({ stream: null, retryable: true, retryAfterMs: 120_000 }));
  await expect(processOpenAIChatCompletionStreamToSse({
    reply,
    stream: brokenStream([textChunk("id1", "partial")]),
    model: "test-model",
    resumeStreamFactory: factory,
    resumeRetry: { maxRetryAfterMs: 60_000 },
  })).rejects.toThrow("upstream connection reset");
  expect(factory).toHaveBeenCalledTimes(1);
});

test("exhausted continuation attempts keep the original failure terminal", async () => {
  const { reply, frames } = createFakeReply();
  const factory = vi.fn(async () => ({
    stream: null,
    retryable: true,
    retryAfterMs: 20,
  }));

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "partial")]),
      model: "test-model",
      resumeStreamFactory: factory,
      resumeRetry: { maxAttempts: 3, defaultBackoffMs: 5, heartbeatIntervalMs: 5 },
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).toHaveBeenCalledTimes(3);
  expect(frames.some((f) => f === ": ping\n\n")).toBe(true);
  expect(frames.some((f) => f === "data: [DONE]\n\n")).toBe(false);
});

test("client abort during the resume gap stops retries immediately", async () => {
  const { reply, frames } = createFakeReply();
  const controller = new AbortController();
  const factory = vi
    .fn()
    .mockImplementationOnce(async () => {
      // 第一次续写被拒后客户端断开（abort 信号由 proxy-handler 接线）。
      setTimeout(() => controller.abort(), 5);
      return { stream: null, retryable: true, retryAfterMs: 10_000 };
    })
    .mockResolvedValueOnce(healthyStream([textChunk("id2", "never"), finishChunk("id2", undefined)]));

  const startedAt = Date.now();
  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "partial")]),
      model: "test-model",
      resumeStreamFactory: factory,
      abortSignal: controller.signal,
      resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 5 },
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).toHaveBeenCalledTimes(1);
  expect(Date.now() - startedAt).toBeLessThan(2000); // 没有干等 10 秒的 Retry-After
  expect(frames.some((f) => f.includes("never"))).toBe(false);
  expect(frames.some((f) => f === "data: [DONE]\n\n")).toBe(false);
});

test("an unexpected factory throw stays terminal (never masks the original error)", async () => {
  const { reply } = createFakeReply();
  const factory = vi.fn(async () => {
    throw new Error("factory bug");
  });

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply,
      stream: brokenStream([textChunk("id1", "partial")]),
      model: "test-model",
      resumeStreamFactory: factory,
      resumeRetry: { maxAttempts: 3, defaultBackoffMs: 1, heartbeatIntervalMs: 0 },
    }),
  ).rejects.toThrow("upstream connection reset");

  expect(factory).toHaveBeenCalledTimes(1);
});

test("an empty upstream stream fails before any header is committed", async () => {
  const { raw } = createReplyStub();

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply: { raw } as any,
      stream: healthyStream([]),
      model: "test-model",
    }),
  ).rejects.toMatchObject({ name: "StreamTruncatedError" });

  expect(raw.headersSent).toBe(false);
});

test("an upstream error before the first chunk leaves headers uncommitted for fallback", async () => {
  const { raw } = createReplyStub();

  await expect(
    processOpenAIChatCompletionStreamToSse({
      reply: { raw } as any,
      stream: brokenStream([], "first frame was an error"),
      model: "test-model",
    }),
  ).rejects.toThrow("first frame was an error");

  expect(raw.headersSent).toBe(false);
});

test("headers and the debug comment are written once, right before the first chunk", async () => {
  const { raw, written } = createReplyStub();
  const writeHead = vi.spyOn(raw, "writeHead");

  await processOpenAIChatCompletionStreamToSse({
    reply: { raw } as any,
    stream: healthyStream([textChunk("id1", "hi"), finishChunk("id1", undefined)]),
    model: "test-model",
    sseComment: "debug",
  });

  expect(writeHead).toHaveBeenCalledTimes(1);
  expect(written[0]).toBe(": debug\n\n");
});

test("a client that disconnects while waiting for drain does not hang the stream", async () => {
  const { raw } = createReplyStub();
  const listeners = new Map<string, () => void>();
  raw.write = () => false;
  raw.on = (event: string, fn: () => void) => listeners.set(event, fn);
  raw.off = () => {};

  const pending = processOpenAIChatCompletionStreamToSse({
    reply: { raw } as any,
    stream: healthyStream([textChunk("id1", "hi"), finishChunk("id1", undefined)]),
    model: "test-model",
  });

  await vi.waitFor(() => expect(listeners.has("close")).toBe(true));
  raw.destroyed = true;
  listeners.get("close")!();

  await expect(pending).resolves.toBeDefined();
});
