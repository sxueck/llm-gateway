import { test, expect, vi } from 'vitest';

// Keep the resume helper import side-effect free in tests (no real DB pool).
vi.mock('../db/index.js', () => ({
  systemConfigDb: { get: vi.fn(async () => undefined) },
}));

import { processOpenAIChatCompletionStreamToSse } from './stream-processor.js';
import {
  buildResumeMessages,
  STREAM_RESUME_INSTRUCTION,
} from '../services/stream-resumer.js';

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

test("buildResumeMessages appends partial assistant text plus continue instruction", () => {
  const original = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];

  const resume = buildResumeMessages(original, "partial answer");

  expect(resume).toHaveLength(4);
  expect(resume[0]).toBe(original[0]);
  expect(resume[1]).toBe(original[1]);
  expect(resume[2]).toEqual({ role: "assistant", content: "partial answer" });
  expect(resume[3].role).toBe("user");
  expect(resume[3].content).toBe(STREAM_RESUME_INSTRUCTION);
  expect(STREAM_RESUME_INSTRUCTION.length).toBeGreaterThan(40);
});
