import { describe, expect, test, vi } from 'vitest';

import { processOpenAIResponsesStreamToSseWithRetry } from './responses-stream-processor.js';

// ---------------------------------------------------------------------------
// Fixtures — official Responses API wire shapes.
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

function inProgressEvent(responseId: string): any {
  return {
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
  };
}

function messageItemAdded(itemId: string, outputIndex = 0): any {
  return {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
  };
}

function contentPartAdded(itemId: string, contentIndex = 0): any {
  return {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: contentIndex,
    part: { type: 'output_text', text: '', annotations: [] },
  };
}

function failedEvent(responseId: string, error: any, output: any[] = []): any {
  return {
    type: 'response.failed',
    response: {
      id: responseId,
      object: 'response',
      status: 'failed',
      error,
      output,
    },
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

function incompleteEvent(responseId: string, itemId: string, text: string): any {
  return {
    type: 'response.incomplete',
    response: {
      id: responseId,
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
    },
  };
}

function parseEvents(frames: string[]): any[] {
  const events: any[] = [];
  for (const frame of frames) {
    for (const line of frame.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          // ignore
        }
      }
    }
  }
  return events;
}

function countType(frames: string[], type: string): number {
  return frames.join('').split(`event: ${type}\n`).length - 1;
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

/** Original stream: created → item → content part → two text deltas, then it dies. */
function dyingOriginalStream() {
  return brokenStream([
    createdEvent('resp_1'),
    inProgressEvent('resp_1'),
    messageItemAdded('item_1'),
    contentPartAdded('item_1', 0),
    textDelta('item_1', 'Hel'),
    textDelta('item_1', 'lo wor'),
  ]);
}

describe('processOpenAIResponsesStreamToSseWithRetry — stream resume', () => {
  test('truncated stream is continued with stable identity and exactly one synthesized terminal', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        createdEvent('resp_2'),
        inProgressEvent('resp_2'),
        messageItemAdded('item_2'),
        textDelta('item_2', 'ld!'),
        {
          type: 'response.output_text.done',
          item_id: 'item_2',
          output_index: 0,
          content_index: 0,
          text: 'ld!',
        },
        completedEvent('resp_2', 'item_2', 'ld!', {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        }),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    // 续写提示拿到的是原始（未还原）部分文本。
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('Hello wor');

    expect(result.streamResumed).toBe(true);
    // 单次创建即成功：创建次数 = 1。
    expect(result.streamResumeAttempts).toBe(1);
    expect(result.streamResumeChars).toBe('Hello wor'.length);
    // 续写后的计费 usage 一律置零，由 chunk 序列重新估算。
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.totalTokens).toBe(0);

    const all = frames.join('');

    // 头部事件不重复：续写流的 created/in_progress/output_item.added 被吞掉。
    expect(countType(frames, 'response.created')).toBe(1);
    expect(countType(frames, 'response.in_progress')).toBe(1);
    expect(countType(frames, 'response.output_item.added')).toBe(1);
    expect(all).not.toContain('resp_2');
    expect(all).not.toContain('item_2');

    // 续写增量重写回原始 item 身份。
    const deltas = parseEvents(frames).filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.map((e) => e.delta)).toEqual(['Hel', 'lo wor', 'ld!']);
    expect(deltas.every((e) => e.item_id === 'item_1')).toBe(true);

    // 终止事件恰好一次，携带原始身份与全文。
    expect(countType(frames, 'response.completed')).toBe(1);
    expect(countType(frames, 'response.output_item.done')).toBe(1);
    expect(countType(frames, 'response.content_part.done')).toBe(1);
    expect(countType(frames, 'response.output_text.done')).toBe(1);

    const textDone = parseEvents(frames).find((e) => e.type === 'response.output_text.done');
    expect(textDone).toMatchObject({ item_id: 'item_1', text: 'Hello world!' });

    const itemDone = parseEvents(frames).find((e) => e.type === 'response.output_item.done');
    expect(itemDone.item).toMatchObject({ id: 'item_1', status: 'completed' });
    expect(itemDone.item.content[0].text).toBe('Hello world!');

    const completed = parseEvents(frames).find((e) => e.type === 'response.completed');
    expect(completed.response).toMatchObject({ id: 'resp_1', status: 'completed' });
    expect(completed.response.output[0]).toMatchObject({ id: 'item_1' });
    expect(completed.response.output[0].content[0].text).toBe('Hello world!');
    // 只把续写请求真实返回的 usage 透传给下游（与 chat 路径一致）。
    expect(completed.response.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });

    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
    // 心跳不进 chunk 序列（此处未配置心跳也不应出现注释帧）。
    expect(result.streamChunks.every((c) => !c.startsWith(':'))).toBe(true);
  });

  test('non-retryable continuation rejection keeps the original failure terminal', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => ({ stream: null, retryable: false, retryAfterMs: 5000 }));

    await expect(
      run(reply, clientReturning(dyingOriginalStream()), {
        resumeStreamFactory: factory,
        resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 10 },
      })
    ).rejects.toThrow('upstream connection reset');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(countType(frames, 'response.completed')).toBe(0);
    expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
  });

  test('retryable rejection with Retry-After: waits it out, heartbeats, then stitches', async () => {
    const { reply, frames } = createReply();
    const factory = vi
      .fn()
      .mockResolvedValueOnce({ stream: null, retryable: true, retryAfterMs: 40 })
      .mockResolvedValueOnce(
        healthyStream([
          messageItemAdded('item_2'),
          textDelta('item_2', 'ld!'),
          completedEvent('resp_2', 'item_2', 'ld!'),
        ])
      );

    const startedAt = Date.now();
    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
      resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 5 },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(factory).toHaveBeenCalledTimes(2);
    expect(result.streamResumed).toBe(true);
    // streamResumeAttempts = 上游续写请求创建次数：被拒的那次 + 重试成功的那次。
    expect(result.streamResumeAttempts).toBe(2);
    expect(result.streamResumeChars).toBe('Hello wor'.length);
    // Retry-After (40ms) 真的被遵守，而不是立即重试。
    expect(elapsedMs).toBeGreaterThanOrEqual(35);

    const heartbeatIdx = frames.findIndex((f) => f === ': ping\n\n');
    const continuationIdx = frames.findIndex((f) => f.includes('ld!'));
    expect(heartbeatIdx).toBeGreaterThan(-1);
    expect(continuationIdx).toBeGreaterThan(heartbeatIdx);
    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
    expect(result.streamChunks.every((c) => !c.startsWith(':'))).toBe(true);
  });

  test('client abort during the resume gap stops retries immediately', async () => {
    const { reply, frames } = createReply();
    const controller = new AbortController();
    const factory = vi
      .fn()
      .mockImplementationOnce(async () => {
        // 第一次续写被拒后客户端断开（abort 信号由 proxy-handler 接线）。
        setTimeout(() => controller.abort(), 5);
        return { stream: null, retryable: true, retryAfterMs: 10_000 };
      })
      .mockResolvedValueOnce(healthyStream([textDelta('item_2', 'never'), completedEvent('resp_2', 'item_2', 'never')]));

    const startedAt = Date.now();
    await expect(
      run(reply, clientReturning(dyingOriginalStream()), {
        resumeStreamFactory: factory,
        abortSignal: controller.signal,
        resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 5 },
      })
    ).rejects.toThrow('upstream connection reset');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2000); // 没有干等 10 秒的 Retry-After
    expect(frames.some((f) => f.includes('never'))).toBe(false);
    expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
  });

  test('a function-call item in the original stream blocks the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      textDelta('item_1', 'Hi'),
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', status: 'in_progress', name: 'get_weather' },
      },
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('reasoning output in the original stream blocks the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      textDelta('item_1', 'Hi'),
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'hmm' },
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('text for a second item in the original stream blocks the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_3', 'nope')]));

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      messageItemAdded('item_2'),
      textDelta('item_1', 'Hi'),
      textDelta('item_2', 'there'),
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('an already-closed output item in the original stream blocks the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    // 上游把 message 项关闭后、在 response.completed 之前中断：
    // 此时不能向已关闭的项追加增量。
    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      textDelta('item_1', 'Hi'),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'item_1', type: 'message', role: 'assistant', status: 'completed', content: [] },
      },
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('a continuation that dies mid-flight stays terminal (no second resume)', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      brokenStream([messageItemAdded('item_2'), textDelta('item_2', 'ld!')])
    );

    await expect(
      run(reply, clientReturning(dyingOriginalStream()), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');

    expect(factory).toHaveBeenCalledTimes(1);
    expect(countType(frames, 'response.completed')).toBe(0);
    expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
  });

  test('an incomplete continuation synthesizes response.incomplete with the original identity', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([textDelta('item_2', 'ld!'), incompleteEvent('resp_2', 'item_2', 'ld!')])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    expect(result.streamResumed).toBe(true);
    expect(countType(frames, 'response.incomplete')).toBe(1);
    expect(countType(frames, 'response.completed')).toBe(0);

    const incomplete = parseEvents(frames).find((e) => e.type === 'response.incomplete');
    expect(incomplete.response).toMatchObject({
      id: 'resp_1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    expect(incomplete.response.output[0]).toMatchObject({ id: 'item_1' });
    expect(incomplete.response.output[0].content[0].text).toBe('Hello world!');
    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
  });

  test('a failed continuation synthesizes one response.failed with the original identity, full text, and preserved error', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        textDelta('item_2', 'ld!'),
        // 续写流的 failed 快照 output 为空——直接透传会丢掉原始段文本。
        failedEvent('resp_2', { code: 'server_error', message: 'upstream exploded' }),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    expect(result.streamResumed).toBe(true);
    expect(countType(frames, 'response.failed')).toBe(1);
    expect(countType(frames, 'response.completed')).toBe(0);

    const events = parseEvents(frames);
    const failed = events.find((e) => e.type === 'response.failed');
    expect(failed.response).toMatchObject({
      id: 'resp_1',
      status: 'failed',
      error: { code: 'server_error', message: 'upstream exploded' },
    });
    // 合成快照保留原始项身份与全部已交付文本，而不是透传丢文本的续写快照。
    expect(failed.response.output[0]).toMatchObject({ id: 'item_1', status: 'incomplete' });
    expect(failed.response.output[0].content[0].text).toBe('Hello world!');
    expect(frames.join('')).not.toContain('resp_2');

    // 没有任何增量出现在失败终态之后。
    const failedIdx = events.indexOf(failed);
    expect(events.slice(failedIdx + 1).some((e) => e.type === 'response.output_text.delta')).toBe(false);
    // 失败终止后仍按既有语义补 [DONE]（与原始流错误事件路径一致）。
    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
  });

  test('restorer tail is flushed before the synthesized failed terminal; no delta lands after a terminal state', async () => {
    const { reply, frames } = createReply();
    // 还原器扣住全部文本，flush 时一次性交还。
    let held = '';
    const streamRestorer = {
      process: (_key: string, content: string) => {
        held += content;
        return '';
      },
      flush: () => {
        const out = held;
        held = '';
        return out;
      },
    };
    const factory = vi.fn(async () =>
      healthyStream([wrappedTextDelta('item_2', 'ld!'), failedEvent('resp_2', { code: 'server_error', message: 'boom' })])
    );

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      wrappedTextDelta('item_1', 'Hello wor'),
    ]);

    const result = await run(reply, clientReturning(original), {
      resumeStreamFactory: factory,
      streamRestorer,
    });
    expect(result.streamResumed).toBe(true);

    const events = parseEvents(frames);
    const failedIdx = events.findIndex((e) => e.type === 'response.failed');
    expect(failedIdx).toBeGreaterThan(-1);

    // 还原器尾巴在终态之前以增量形式交付（先 flush restorer 再下发终态）。
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.length).toBeGreaterThan(0);
    const lastDeltaIdx = events.lastIndexOf(deltas[deltas.length - 1]);
    expect(lastDeltaIdx).toBeLessThan(failedIdx);
    expect(deltas.some((e) => e.delta?.text === 'Hello wor')).toBe(true);
    expect(deltas.some((e) => e.delta?.text === 'ld!')).toBe(true);

    // 终态之后没有任何事件。
    expect(events.slice(failedIdx + 1).some((e) => e.type === 'response.output_text.delta')).toBe(false);
    const failed = events[failedIdx];
    expect(failed.response.id).toBe('resp_1');
    expect(failed.response.output[0].content[0].text).toBe('Hello world!');
  });

  test('a continuation response.error event is never swallowed: it terminates as a synthesized failure', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        textDelta('item_2', 'ld!'),
        { type: 'response.error', error: { type: 'rate_limit_error', message: 'quota exceeded' } },
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    expect(result.streamResumed).toBe(true);
    expect(countType(frames, 'response.completed')).toBe(0);
    expect(countType(frames, 'response.failed')).toBe(1);
    const failed = parseEvents(frames).find((e) => e.type === 'response.failed');
    expect(failed.response.id).toBe('resp_1');
    expect(failed.response.error).toMatchObject({ type: 'rate_limit_error', message: 'quota exceeded' });
    expect(failed.response.output[0].content[0].text).toBe('Hello world!');
    expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');
  });

  test('a function_call item in the continuation fails terminally instead of faking success', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        textDelta('item_2', 'ld!'),
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { id: 'fc_1', type: 'function_call', name: 'get_weather', status: 'in_progress' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"city"' },
        completedEvent('resp_2', 'item_2', 'ld!'),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    expect(result.streamResumed).toBe(true);
    expect(countType(frames, 'response.completed')).toBe(0);
    expect(countType(frames, 'response.failed')).toBe(1);
    const events = parseEvents(frames);
    const failed = events.find((e) => e.type === 'response.failed');
    expect(failed.response.id).toBe('resp_1');
    expect(failed.response.error).toMatchObject({ code: 'server_error' });
    expect(typeof failed.response.error.message).toBe('string');
    expect(failed.response.error.message.length).toBeGreaterThan(0);
    // 已交付文本保留在失败快照里；工具项不静默丢弃后伪造成功。
    expect(failed.response.output[0].content[0].text).toBe('Hello world!');
    // 工具参数增量不出现在任何位置，更不出现在终态之后。
    expect(frames.join('')).not.toContain('{"city"');
    const failedIdx = events.indexOf(failed);
    expect(events.slice(failedIdx + 1).some((e) => e.type === 'response.output_text.delta')).toBe(false);
  });

  test('PII restorer: raw text goes back upstream, restored text goes downstream', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([wrappedTextDelta('item_2', ' more SECRET)'), completedEvent('resp_2', 'item_2', 'done')])
    );
    const streamRestorer = {
      process: (_key: string, content: string) => content.replace(/SECRET/g, 'RESTORED'),
      flush: () => '',
    };

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      wrappedTextDelta('item_1', 'code SECRET'),
    ]);

    const result = await run(reply, clientReturning(original), {
      resumeStreamFactory: factory,
      streamRestorer,
    });

    // 续写提示用上游原文（未还原），还原结果只写给客户端。
    expect(factory).toHaveBeenCalledWith('code SECRET');

    const all = frames.join('');
    expect(all).toContain('RESTORED');
    expect(all).not.toContain('SECRET');
    expect(result.streamResumed).toBe(true);

    const textDone = parseEvents(frames).find((e) => e.type === 'response.output_text.done');
    expect(textDone.text).toBe('code RESTORED more RESTORED)');
  });

  test('client disconnect during the original stream disables the resume', async () => {
    const { reply, raw, frames } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    const original = (async function* () {
      yield createdEvent('resp_1');
      yield messageItemAdded('item_1');
      yield textDelta('item_1', 'Hi');
      raw.destroyed = true;
      throw new Error('upstream connection reset');
    })();

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
    expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
  });

  test('sequence numbers are renumbered monotonically across the stitched stream', async () => {
    const { reply, frames } = createReply();
    // 续写流自带从 20 起步的编号，直接透传会回退到原始段编号之后。
    const factory = vi.fn(async () =>
      healthyStream([
        { ...messageItemAdded('item_2'), sequence_number: 20 },
        { ...textDelta('item_2', 'ld!'), sequence_number: 21 },
        { ...completedEvent('resp_2', 'item_2', 'ld!'), sequence_number: 22 },
      ])
    );

    const original = brokenStream([
      { ...createdEvent('resp_1'), sequence_number: 2 },
      { ...messageItemAdded('item_1'), sequence_number: 3 },
      { ...textDelta('item_1', 'Hel'), sequence_number: 4 },
      { ...textDelta('item_1', 'lo wor'), sequence_number: 5 },
    ]);

    const result = await run(reply, clientReturning(original), { resumeStreamFactory: factory });
    expect(result.streamResumed).toBe(true);

    const events = parseEvents(frames);
    const seqs = events.map((e) => e.sequence_number);
    // 原始段保留上游编号不变。
    expect(seqs.slice(0, 4)).toEqual([2, 3, 4, 5]);
    // 续写段（含全部合成事件）在其后严格单调递增。
    const rest = seqs.slice(4);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((n) => typeof n === 'number')).toBe(true);
    for (let i = 1; i < rest.length; i++) {
      expect(rest[i]).toBeGreaterThan(rest[i - 1]);
    }
    expect(rest[0]).toBeGreaterThan(5);
    // 续写流自带编号不透传。
    expect(frames.join('')).not.toContain('"sequence_number":20');
    expect(frames.join('')).not.toContain('"sequence_number":21');
  });

  test('normal (non-resumed) streams keep upstream sequence numbers untouched', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'never')]));
    const original = healthyStream([
      { ...createdEvent('resp_1'), sequence_number: 7 },
      { ...messageItemAdded('item_1'), sequence_number: 8 },
      { ...textDelta('item_1', 'hi'), sequence_number: 9 },
      { ...completedEvent('resp_1', 'item_1', 'hi'), sequence_number: 10 },
    ]);

    await run(reply, clientReturning(original), { resumeStreamFactory: factory });

    expect(factory).not.toHaveBeenCalled();
    const seqs = parseEvents(frames).map((e) => e.sequence_number);
    expect(seqs).toEqual([7, 8, 9, 10]);
  });

  test('when the original stream omits sequence numbers, stitched events stay free of them', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        { ...textDelta('item_2', 'ld!'), sequence_number: 21 },
        { ...completedEvent('resp_2', 'item_2', 'ld!'), sequence_number: 22 },
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });
    expect(result.streamResumed).toBe(true);

    const events = parseEvents(frames);
    // 续写流自带的编号被剥掉，不中途引入回退的编号序列。
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((e) => !('sequence_number' in e))).toBe(true);
    const synthesizedTypes = [
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ];
    const synthesized = events.filter((e) => synthesizedTypes.includes(e.type));
    expect(synthesized.length).toBe(4);
    expect(synthesized.every((e) => !('sequence_number' in e))).toBe(true);
  });

  test('multiple content parts in the original stream block the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      contentPartAdded('item_1', 0),
      textDelta('item_1', 'Hi'),
      contentPartAdded('item_1', 1),
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('a non-zero content_index in the original stream blocks the resume', async () => {
    const { reply } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    const original = brokenStream([
      createdEvent('resp_1'),
      messageItemAdded('item_1'),
      { type: 'response.output_text.delta', item_id: 'item_1', output_index: 0, content_index: 1, delta: 'Hi' },
    ]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
  });

  test('a missing original response id blocks the resume', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () => healthyStream([textDelta('item_2', 'nope')]));

    // 原始流从未携带 response 快照（无 id），无法保持身份稳定。
    const original = brokenStream([messageItemAdded('item_1'), textDelta('item_1', 'Hi')]);

    await expect(
      run(reply, clientReturning(original), { resumeStreamFactory: factory })
    ).rejects.toThrow('upstream connection reset');
    expect(factory).not.toHaveBeenCalled();
    expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
  });
});
