import { describe, expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

import { processOpenAIResponsesStreamToSseWithRetry } from './responses-stream-processor.js';
import {
  countStreamResponseTokens,
  countTextCooperatively,
  countTokensForText,
} from '../services/token-counter.js';

// ---------------------------------------------------------------------------
// F2 回归（修正版）：Responses 续传用量不得依赖被 BoundedChunkRecorder 截断
// 的磁带（默认 256KiB 录制上限；本文件用真实默认预算，不注入小预算）。
//
// 处理器把合成终态所用的 clientText 全量（原始段 + 续写段 + 还原器尾巴）
// 作为 deliveredOutputText 原样上报（引用传递，不新增文本副本/无界缓冲）；
// 续传计费（成功与合成失败）直接对完整文本用真实分词器按既有口径计数——
// 磁带保持原样仅供日志，不做基于丢弃字符的 chars/4 估算（对中文/代码
// 显著低估）。
// ---------------------------------------------------------------------------

const RESUME_MAX_CHARS = 64 * 1024; // STREAM_RESUME_MAX_CHARS：可续传的原始段上限。
const TAPE_BUDGET_CHARS = 256 * 1024; // BoundedChunkRecorder 默认录制上限。
const CHUNK_CHARS = 2048;

function createReply() {
  const frames: string[] = [];
  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: () => {
      raw.headersSent = true;
    },
    write: (chunk: any) => {
      frames.push(String(chunk));
      return true;
    },
    end: () => {
      raw.writableEnded = true;
    },
  };
  return { reply: { raw } as any, frames, raw };
}

async function* brokenStream(events: any[]): AsyncIterable<any> {
  for (const event of events) yield event;
  throw new Error('upstream connection reset');
}

async function* healthyStream(events: any[]): AsyncIterable<any> {
  for (const event of events) yield event;
}

function clientReturning(stream: AsyncIterable<any>) {
  return { responses: { create: async () => stream } };
}

function createdEvent(responseId: string): any {
  return {
    type: 'response.created',
    response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
  };
}

function messageItemAdded(itemId: string): any {
  return {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
  };
}

function textDelta(itemId: string, text: string): any {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  };
}

function wrappedTextDelta(itemId: string, text: string): any {
  return {
    type: 'response.output_text.delta',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: { text },
  };
}

function completedEvent(responseId: string, itemId: string, text: string, usage?: any): any {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      object: 'response',
      status: 'completed',
      output: [
        {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      ...(usage ? { usage } : {}),
    },
  };
}

function failedEvent(responseId: string, error: any): any {
  return {
    type: 'response.failed',
    response: { id: responseId, object: 'response', status: 'failed', error, output: [] },
  };
}

/** 从 SSE 帧里提取 output_text.delta 的文本（与 token 计数器同口径）。 */
function deltaTextsFromFrames(frames: string[]): string[] {
  const texts: string[] = [];
  for (const frame of frames) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed?.type !== 'response.output_text.delta') continue;
        const delta: any = parsed.delta;
        if (typeof delta === 'string') texts.push(delta);
        else if (delta && typeof delta.text === 'string') texts.push(delta.text);
        else if (typeof parsed.text === 'string') texts.push(parsed.text);
      } catch {
        // ignore
      }
    }
  }
  return texts;
}

function charLength(texts: string[]): number {
  return texts.reduce((sum, t) => sum + t.length, 0);
}

function run(reply: any, client: any, overrides: Record<string, any> = {}) {
  return processOpenAIResponsesStreamToSseWithRetry({
    client,
    requestParams: {},
    reply,
    responseHeaders: {},
    totalAttempts: 1,
    initTimeoutMs: 0,
    ...overrides,
  });
}

/** 原始段：created → item → chunks×CHUNK_CHARS 字符增量后中断
 *（原始段 ≤ 64KiB 续传上限，可续；合计输出超 256KiB 让磁带截断）。 */
function dyingOriginalStream(chunk: string, chunks: number) {
  return brokenStream([
    createdEvent('resp_1'),
    messageItemAdded('item_1'),
    ...Array.from({ length: chunks }, () => textDelta('item_1', chunk)),
  ]);
}

/** 续写段增量帧（wrapped delta 形态）。 */
function continuationDeltas(itemId: string, chunk: string, chunks: number): any[] {
  return Array.from({ length: chunks }, () => wrappedTextDelta(itemId, chunk));
}

const ORIGINAL_CHUNKS = 30; // 61440 chars ≤ 64KiB（STREAM_RESUME_MAX_CHARS）
const CONT_CHUNKS = 120; // 245760 chars：合计 307200 chars > 256KiB → 磁带截断

describe('processOpenAIResponsesStreamToSseWithRetry — resume usage vs truncated tape', () => {
  test('成功续传（ASCII 超 256KiB 磁带）：deliveredOutputText 为全文，估算按真实分词计数', async () => {
    const originalChunk = 'A'.repeat(CHUNK_CHARS);
    const contChunk = 'B'.repeat(CHUNK_CHARS);
    const fullText = originalChunk.repeat(ORIGINAL_CHUNKS) + contChunk.repeat(CONT_CHUNKS);

    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        ...continuationDeltas('item_2', contChunk, CONT_CHUNKS),
        completedEvent('resp_2', 'item_2', contChunk.repeat(CONT_CHUNKS)),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream(originalChunk, ORIGINAL_CHUNKS)), {
      resumeStreamFactory: factory,
    });

    expect(result.streamResumed).toBe(true);
    expect(result.streamResumeChars).toBe(CHUNK_CHARS * ORIGINAL_CHUNKS);
    expect(result.streamResumeChars).toBeLessThanOrEqual(RESUME_MAX_CHARS);

    // 客户端确实收到了全部文本（磁带截断不影响下发）。
    expect(charLength(deltaTextsFromFrames(frames))).toBe(fullText.length);
    expect(fullText.length).toBeGreaterThan(TAPE_BUDGET_CHARS);

    // 完整已交付输出 = clientText 原文（引用传递，无副本），与磁带截断无关。
    expect(result.deliveredOutputText).toBe(fullText);

    // 磁带被默认 256KiB 上限截断：只录到前缀。
    const tapeDeltaChars = charLength(deltaTextsFromFrames(result.streamChunks));
    expect(tapeDeltaChars).toBeGreaterThan(0);
    expect(tapeDeltaChars).toBeLessThan(fullText.length);

    // 总输出用真实分词器按既有口径对完整文本计数（不是只数磁带前缀，
    // 也不是 chars/4 估算）。原客户端 prompt 恰好计一次。
    const requestBody = { input: 'hi' };
    const tapeOnly = await countStreamResponseTokens(requestBody, result.streamChunks);
    const complete = await countStreamResponseTokens(
      requestBody,
      result.streamChunks,
      result.deliveredOutputText
    );

    expect(complete.completionTokens).toBe(await countTextCooperatively(fullText));
    expect(complete.completionTokens).toBeGreaterThan(tapeOnly.completionTokens);
    expect(complete.promptTokens).toBe(countTokensForText('hi'));
    expect(complete.totalTokens).toBe(complete.promptTokens + complete.completionTokens);
  });

  test('合成失败续传（中文超 256KiB 磁带）：失败行同样按全文真实分词计数', async () => {
    // 保留同样的字符数和真实分词，但用标点避免让整段连续中文变成一个 BPE 片段。
    const sentenceChunk = (text: string) => text.repeat(Math.ceil(CHUNK_CHARS / text.length)).slice(0, CHUNK_CHARS);
    const originalChunk = sentenceChunk('初始回复已经发送。');
    const contChunk = sentenceChunk('续写内容仍需计入完整用量。');
    const fullText = originalChunk.repeat(ORIGINAL_CHUNKS) + contChunk.repeat(CONT_CHUNKS);

    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        ...continuationDeltas('item_2', contChunk, CONT_CHUNKS),
        failedEvent('resp_2', { code: 'server_error', message: 'continuation exploded' }),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream(originalChunk, ORIGINAL_CHUNKS)), {
      resumeStreamFactory: factory,
    });

    // 续写段失败：以原始身份合成 response.failed 终态，按失败审计。
    expect(result.streamResumed).toBe(true);
    expect(result.streamFailed).toBe(true);
    expect(result.streamFailure).toMatchObject({ code: 'server_error', message: 'continuation exploded' });

    // 完整核算覆盖原始段 + 续写段已交付增量（clientText 原文）。
    expect(result.deliveredOutputText).toBe(fullText);
    expect(fullText.length).toBeGreaterThan(TAPE_BUDGET_CHARS);
    const tapeDeltaChars = charLength(deltaTextsFromFrames(result.streamChunks));
    expect(tapeDeltaChars).toBeLessThan(fullText.length);

    const requestBody = { input: 'hi' };
    const complete = await countStreamResponseTokens(
      requestBody,
      result.streamChunks,
      result.deliveredOutputText
    );

    // 中文：真实分词计数远大于 chars/4 启发式（修复前会显著低估）。
    expect(complete.completionTokens).toBe(await countTextCooperatively(fullText));
    expect(complete.completionTokens).toBeGreaterThan(Math.ceil(fullText.length / 4));
    expect(complete.promptTokens).toBe(countTokensForText('hi'));
    expect(complete.totalTokens).toBe(complete.promptTokens + complete.completionTokens);

    // 下游确实收到了全部已交付文本（失败终态快照携带全文）。
    expect(frames.join('').includes('response.failed')).toBe(true);
    expect(charLength(deltaTextsFromFrames(frames))).toBe(fullText.length);
  });

  test('非续传流：默认预算不截断，上游 usage 照旧优先，估算口径不变', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'never')]));

    const original = healthyStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      textDelta('item_1', 'short answer'),
      completedEvent('resp_1', 'item_1', 'short answer', {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      }),
    ]);

    const result = await run(reply, clientReturning(original), {
      resumeStreamFactory: factory,
    });

    expect(factory).not.toHaveBeenCalled();
    expect(result.streamResumed).toBeUndefined();

    // 非续传行为保留：上游 usage 优先，不做磁带估算。
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(7);
    expect(result.totalTokens).toBe(18);

    // 非续传不携带完整文本核算（deliveredOutputText 仅续传路径上报），
    // 磁带口径保持原样。
    expect(result.deliveredOutputText).toBeUndefined();

    const requestBody = { input: 'hi' };
    const tapeOnly = await countStreamResponseTokens(requestBody, result.streamChunks);
    expect(tapeOnly.completionTokens).toBe(countTokensForText('short answer'));
  });
});
