import { describe, expect, test, vi } from 'vitest';

import { processOpenAIResponsesStreamToSseWithRetry } from './responses-stream-processor.js';
import { consumeResponsesSseWithSdk } from './openai-sdk-oracle.js';

// ---------------------------------------------------------------------------
// openai@7.25.0 SDK oracle：用真实的 ResponseStream 聚合器消费网关下游
// resume SSE，按语义判定「正常结束 / 明确失败」，断言身份、全文与终态。
// 任何为过测而修改本 oracle 的行为都是禁止的。
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

// --- 官方 Responses API wire shape fixtures -------------------------------

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

function contentPartAdded(itemId: string): any {
  return {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
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

function outputTextDone(itemId: string, text: string): any {
  return {
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  };
}

function failedEvent(responseId: string, error: any, output: any[] = []): any {
  return {
    type: 'response.failed',
    response: { id: responseId, object: 'response', status: 'failed', error, output },
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

/** 原始流：created → in_progress → item → content part → 两段文本后中断。 */
function dyingOriginalStream() {
  return brokenStream([
    createdEvent('resp_1'),
    inProgressEvent('resp_1'),
    messageItemAdded('item_1'),
    contentPartAdded('item_1'),
    textDelta('item_1', 'Hel'),
    textDelta('item_1', 'lo wor'),
  ]);
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

function messageItemOf(response: any): any {
  return (response?.output ?? []).find((item: any) => item?.type === 'message');
}

describe('Responses resume SSE — openai@7.25.0 SDK oracle', () => {
  test('成功续写：SDK 聚合器还原原始身份、全文与 completed 终态', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        createdEvent('resp_2'),
        inProgressEvent('resp_2'),
        messageItemAdded('item_2'),
        contentPartAdded('item_2'),
        textDelta('item_2', 'ld!'),
        outputTextDone('item_2', 'ld!'),
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

    // 网关信号：确实续写过；成功终态不携带失败信号。
    expect(result.streamResumed).toBe(true);
    expect(result.streamFailed ?? false).toBe(false);

    // SDK oracle：真实聚合器消费完整下游 SSE。
    const outcome = await consumeResponsesSseWithSdk(frames);
    expect(outcome.error).toBeNull();
    expect(outcome.sawDoneSentinel).toBe(true);

    const response = outcome.response;
    // 身份：原始 response / item，续写身份不外泄。
    expect(response.id).toBe('resp_1');
    const item = messageItemOf(response);
    expect(item?.id).toBe('item_1');
    expect(frames.join('')).not.toContain('resp_2');
    expect(frames.join('')).not.toContain('item_2');
    // 全文：拼接后的完整文本（聚合器与逐项内容一致）。
    expect(response.output_text).toBe('Hello world!');
    expect(item?.content?.[0]?.text).toBe('Hello world!');
    // 终态：恰好一次 completed，且是最后一个生命周期事件。
    expect(response.status).toBe('completed');
    const lifecycle = outcome.eventTypes.filter((t) =>
      ['response.completed', 'response.failed', 'response.incomplete'].includes(t)
    );
    expect(lifecycle).toEqual(['response.completed']);
    // usage 只透传续写请求真实返回的。
    expect(response.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  });

  test('续写 response.failed：明确失败终态、错误与全文保留，且调用方不拿到伪造的成功信号', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([
        textDelta('item_2', 'ld!'),
        failedEvent('resp_2', { code: 'server_error', message: 'upstream exploded' }),
      ])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    const outcome = await consumeResponsesSseWithSdk(frames);
    expect(outcome.error).toBeNull();
    expect(outcome.sawDoneSentinel).toBe(true);

    const response = outcome.response;
    // 身份与全文：失败快照必须保留原始身份与全部已交付文本。
    expect(response.id).toBe('resp_1');
    expect(messageItemOf(response)?.id).toBe('item_1');
    expect(response.output_text).toBe('Hello world!');
    // 终态：明确失败，绝不伪造 completed。
    expect(response.status).toBe('failed');
    expect(response.error).toMatchObject({ code: 'server_error', message: 'upstream exploded' });
    const lifecycle = outcome.eventTypes.filter((t) =>
      ['response.completed', 'response.failed', 'response.incomplete'].includes(t)
    );
    expect(lifecycle).toEqual(['response.failed']);
    // 失败终态之后不允许再出现任何增量（SDK 解析器看到的最后一个事件即 failed）。
    expect(outcome.eventTypes[outcome.eventTypes.length - 1]).toBe('response.failed');

    // 审计信号：调用方必须看到显式失败，而不是 success:true 一路绿灯。
    expect(result.streamFailed).toBe(true);
    expect(result.streamFailure).toMatchObject({ code: 'server_error', message: 'upstream exploded' });
  });

  test('续写 response.error：错误事件不被吞掉，合成失败终态并保留原始身份', async () => {
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

    const outcome = await consumeResponsesSseWithSdk(frames);
    expect(outcome.error).toBeNull();

    const response = outcome.response;
    expect(response.id).toBe('resp_1');
    expect(response.status).toBe('failed');
    expect(response.error).toMatchObject({ type: 'rate_limit_error', message: 'quota exceeded' });
    expect(response.output_text).toBe('Hello world!');
    expect(outcome.eventTypes).not.toContain('response.completed');
    expect(outcome.eventTypes).not.toContain('response.error'); // 错误被合成为 failed，不透传非官方帧

    expect(result.streamFailed).toBe(true);
    expect(result.streamFailure).toMatchObject({ message: 'quota exceeded' });
  });

  test('续写 incomplete：合法未完成终态（非失败），全文与原因保留', async () => {
    const { reply, frames } = createReply();
    const factory = vi.fn(async () =>
      healthyStream([textDelta('item_2', 'ld!'), incompleteEvent('resp_2', 'item_2', 'ld!')])
    );

    const result = await run(reply, clientReturning(dyingOriginalStream()), {
      resumeStreamFactory: factory,
    });

    const outcome = await consumeResponsesSseWithSdk(frames);
    expect(outcome.error).toBeNull();
    expect(outcome.sawDoneSentinel).toBe(true);

    const response = outcome.response;
    expect(response.id).toBe('resp_1');
    expect(messageItemOf(response)?.id).toBe('item_1');
    expect(response.output_text).toBe('Hello world!');
    // incomplete 是上游合法终态：正常结束，但不是 completed。
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details).toMatchObject({ reason: 'max_output_tokens' });
    expect(outcome.eventTypes).not.toContain('response.completed');
    expect(outcome.eventTypes).not.toContain('response.failed');

    // 语义判定：incomplete 不算明确失败，不得打失败信号。
    expect(result.streamFailed ?? false).toBe(false);
  });

  test('续写间隙客户端 abort：无终态、无 [DONE]，绝不虚构 completed', async () => {
    const { reply, frames } = createReply();
    const controller = new AbortController();
    const factory = vi
      .fn()
      .mockImplementationOnce(async () => {
        // 第一次续写被拒后客户端断开（abort 信号由 proxy-handler 接线）。
        setTimeout(() => controller.abort(), 5);
        return { stream: null, retryable: true, retryAfterMs: 10_000 };
      })
      .mockResolvedValueOnce(
        healthyStream([textDelta('item_2', 'never'), completedEvent('resp_2', 'item_2', 'never')])
      );

    await expect(
      run(reply, clientReturning(dyingOriginalStream()), {
        resumeStreamFactory: factory,
        abortSignal: controller.signal,
        resumeRetry: { heartbeatIntervalMs: 10, defaultBackoffMs: 5 },
      })
    ).rejects.toThrow('upstream connection reset');

    // 下游只见部分文本；没有终止事件、没有 [DONE]。
    expect(frames.some((f) => f.includes('never'))).toBe(false);
    expect(frames.some((f) => f.trim() === 'data: [DONE]')).toBe(false);

    const outcome = await consumeResponsesSseWithSdk(frames);
    // 本场景本无可完成的 response：SDK 聚合器不能给出 completed/failed/incomplete。
    expect(outcome.sawDoneSentinel).toBe(false);
    const lifecycle = outcome.eventTypes.filter((t) =>
      ['response.completed', 'response.failed', 'response.incomplete'].includes(t)
    );
    expect(lifecycle).toEqual([]);
    expect(outcome.response?.status ?? 'in_progress').not.toBe('completed');
    // 已交付的部分文本仍然一致（不虚构、不丢失）。
    expect(outcome.response?.output_text).toBe('Hello wor');
  });

  test('续写出现工具调用：失败终止而非伪造成功，工具内容不泄漏，全文保留', async () => {
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

    const outcome = await consumeResponsesSseWithSdk(frames);
    expect(outcome.error).toBeNull();

    const response = outcome.response;
    // 身份与全文：工具项出现前已交付的文本完整保留在失败快照中。
    expect(response.id).toBe('resp_1');
    expect(response.output_text).toBe('Hello world!');
    // 终态：明确失败；不得静默丢弃工具项后伪造 completed。
    expect(response.status).toBe('failed');
    expect(typeof response.error?.message).toBe('string');
    expect(response.error?.message?.length ?? 0).toBeGreaterThan(0);
    expect(outcome.eventTypes).not.toContain('response.completed');
    // 工具内容对下游（SDK 视角）完全不可见。
    const all = frames.join('');
    expect(all).not.toContain('get_weather');
    expect(all).not.toContain('{"city"');

    // 审计信号：调用方必须看到显式失败。
    expect(result.streamFailed).toBe(true);
    expect(result.streamFailure?.message).toBeTruthy();
  });
});
