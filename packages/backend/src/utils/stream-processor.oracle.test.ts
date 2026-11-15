import { describe, expect, test, vi } from 'vitest';

import { processOpenAIChatCompletionStreamToSse } from './stream-processor.js';
import { consumeChatSseWithSdk } from './openai-sdk-oracle.js';

// ---------------------------------------------------------------------------
// openai@7.25.0 SDK oracle：用真实的 ChatCompletionStream 聚合器消费网关
// 下游 resume SSE，按语义判定「正常结束 / 明确失败」，断言身份、全文与
// 终态。不得为过测修改 oracle。
// ---------------------------------------------------------------------------

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
  return { reply: { raw } as any, frames };
}

async function* healthyStream(chunks: any[]): AsyncIterable<any> {
  for (const chunk of chunks) yield chunk;
}

async function* brokenStream(chunks: any[], message = 'upstream connection reset'): AsyncIterable<any> {
  for (const chunk of chunks) yield chunk;
  throw new Error(message);
}

// --- 官方 Chat Completions wire shape fixtures ----------------------------

function roleChunk(id: string): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  };
}

function textChunk(id: string, content: string): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

function finishChunk(id: string, usage: any): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage,
  };
}

describe('chat resume SSE — openai@7.25.0 SDK oracle', () => {
  test('成功续写：SDK 聚合器还原稳定身份、全文与 stop 终态', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        roleChunk('id2'),
        textChunk('id2', 'ld!'),
        finishChunk('id2', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
      ])
    );

    const usage = await processOpenAIChatCompletionStreamToSse({
      reply,
      // 官方流总是以 role 块开头（首个 attempt 负责声明 assistant 身份）。
      stream: brokenStream([
        roleChunk('id1'),
        textChunk('id1', 'Hel'),
        textChunk('id1', 'lo wor'),
      ]),
      model: 'test-model',
      resumeStreamFactory: factory,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('Hello wor');
    expect(usage.streamResumed).toBe(true);

    // SDK oracle：真实聚合器消费完整下游 SSE。
    const outcome = await consumeChatSseWithSdk(frames);
    expect(outcome.error).toBeNull();
    expect(outcome.sawDoneSentinel).toBe(true);

    const completion = outcome.completion;
    // 身份：续写块全部重写回原始 id，SDK 只看到一个请求。
    expect(completion.id).toBe('id1');
    expect(frames.join('')).not.toContain('"id":"id2"');
    // 全文与终态：拼接文本 + stop；usage 来自续写请求。
    expect(completion.choices[0].message.content).toBe('Hello world!');
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(outcome.message?.content).toBe('Hello world!');
    expect(completion.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  });

  test('续写中途再次失败：保持原始失败终态，SDK 视角无 finish_reason、无 [DONE]', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => brokenStream([textChunk('id2', 'more')], 'second failure'));

    await expect(
      processOpenAIChatCompletionStreamToSse({
        reply,
        stream: brokenStream([textChunk('id1', 'first ')]),
        model: 'test-model',
        resumeStreamFactory: factory,
      })
    ).rejects.toThrow('second failure');

    // 明确失败：下游没有终止块、没有 [DONE] 哨兵。
    expect(frames.some((f) => f.trim() === 'data: [DONE]')).toBe(false);

    const outcome = await consumeChatSseWithSdk(frames);
    // SSE 帧本身合法；但 SDK 聚合器把「无 finish_reason 的结束」判定为
    // 明确失败（finalChatCompletion 拒绝），绝不虚构完成。
    expect(outcome.error).toMatchObject({ message: 'missing finish_reason for choice 0' });
    expect(outcome.sawDoneSentinel).toBe(false);

    // 已交付文本仍如实累积（通过公共 chunk 事件快照核对）；无完成结果。
    expect(outcome.lastSnapshot?.choices?.[0]?.message?.content).toBe('first more');
    expect(outcome.completion).toBeNull();
  });

  test('客户端 abort：不续写、不下发终态，SDK 视角保持未完成', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => healthyStream([textChunk('id2', 'never')]));

    async function* abortingStream(): AsyncIterable<any> {
      yield textChunk('id1', 'some text ');
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }

    await expect(
      processOpenAIChatCompletionStreamToSse({
        reply,
        stream: abortingStream(),
        model: 'test-model',
        resumeStreamFactory: factory,
      })
    ).rejects.toThrow('aborted');

    // abort 场景本无可完成 response：不虚构 completed。
    expect(factory).not.toHaveBeenCalled();
    expect(frames.some((f) => f.includes('never'))).toBe(false);
    expect(frames.some((f) => f.trim() === 'data: [DONE]')).toBe(false);

    const outcome = await consumeChatSseWithSdk(frames);
    // abort 场景本无可完成 response：SDK 判定为明确失败，不虚构完成。
    expect(outcome.error).toMatchObject({ message: 'missing finish_reason for choice 0' });
    expect(outcome.sawDoneSentinel).toBe(false);
    expect(outcome.lastSnapshot?.choices?.[0]?.message?.content).toBe('some text ');
    expect(outcome.completion).toBeNull();
  });

  test('已下发工具调用片段：拒绝续写并保持失败，工具内容如实可见且无终态', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => healthyStream([textChunk('id2', 'never')]));

    const toolChunk = {
      ...textChunk('id1', 'about to call '),
      choices: [
        {
          index: 0,
          delta: {
            content: 'about to call ',
            tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '{"city"' } }],
          },
          finish_reason: null,
        },
      ],
    };

    await expect(
      processOpenAIChatCompletionStreamToSse({
        reply,
        stream: brokenStream([textChunk('id1', 'text '), toolChunk]),
        model: 'test-model',
        resumeStreamFactory: factory,
      })
    ).rejects.toThrow('upstream connection reset');

    // 工具片段已下发：拼接不可靠，必须拒绝续写（tool 拒绝场景）。
    expect(factory).not.toHaveBeenCalled();
    expect(frames.some((f) => f.trim() === 'data: [DONE]')).toBe(false);

    const outcome = await consumeChatSseWithSdk(frames);
    // 无终态结束：SDK 聚合器判定为明确失败（不虚构 stop）。
    expect(outcome.error).toMatchObject({ message: 'missing finish_reason for choice 0' });
    expect(outcome.sawDoneSentinel).toBe(false);

    // SDK 视角：文本与工具调用如实累积（不篡改、不丢弃），但无完成结果。
    const message = outcome.lastSnapshot?.choices?.[0]?.message;
    expect(message?.content).toBe('text about to call ');
    expect(message?.tool_calls?.[0]?.function).toMatchObject({
      name: 'get_weather',
      arguments: '{"city"',
    });
    expect(outcome.completion).toBeNull();
  });
});
