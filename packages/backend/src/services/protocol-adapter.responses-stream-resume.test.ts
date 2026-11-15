import { test, expect, vi } from 'vitest';

// 续写开关走真实 stream-resumer 逻辑：mock DB 返回 enabled。
vi.mock('../db/index.js', () => ({
  systemConfigDb: { get: vi.fn(async () => ({ value: 'true' })) },
}));

import { ProtocolAdapter } from './protocol-adapter.js';
import { buildResumeResponsesInput, STREAM_RESUME_INSTRUCTION } from './stream-resumer.js';

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

function completedEvent(responseId: string, itemId: string, text: string): any {
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
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    },
  };
}

function createFakeReply() {
  const frames: string[] = [];
  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: () => {
      raw.headersSent = true;
    },
    write: (data: any) => {
      frames.push(String(data));
      return true;
    },
    end: () => {
      raw.writableEnded = true;
    },
    once: () => {},
  };
  return { reply: { raw } as any, frames };
}

test('responses stream resume disables tools and stitches one plain-text segment', async () => {
  const adapter = new ProtocolAdapter();
  const createCalls: any[] = [];

  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: async (params: any) => {
        createCalls.push(params);

        if (createCalls.length === 1) {
          // 初始流：输出 'Hel' 后中断。
          async function* broken(): AsyncIterable<any> {
            yield createdEvent('resp_1');
            yield messageItemAdded('item_1');
            yield textDelta('item_1', 'Hel');
            throw new Error('upstream connection reset');
          }
          return broken();
        }

        // 续写请求成功。
        async function* continuation(): AsyncIterable<any> {
          yield createdEvent('resp_2');
          yield messageItemAdded('item_2');
          yield textDelta('item_2', 'lo');
          yield completedEvent('resp_2', 'item_2', 'lo');
        }
        return continuation();
      },
    },
  });

  const { reply, frames } = createFakeReply();
  const usage = await adapter.streamResponse(
    {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'gpt-test',
    },
    'Hi',
    {},
    reply,
    undefined
  );

  // 初始请求 + 续写请求。
  expect(createCalls).toHaveLength(2);

  // 续写参数：原输入 + 部分输出（output_text）+ 继续指令；工具被禁用。
  const resumeParams = createCalls[1];
  expect(resumeParams.input).toEqual([
    { role: 'user', content: 'Hi' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hel' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: STREAM_RESUME_INSTRUCTION }] },
  ]);
  expect(resumeParams.tools).toBeUndefined();
  expect(resumeParams.tool_choice).toBe('none');
  expect(resumeParams.parallel_tool_calls).toBeUndefined();
  expect(resumeParams.model).toBe('gpt-test');
  expect(resumeParams.stream).toBe(true);

  // 下游只见原始身份，头部/终止事件不重复。
  const all = frames.join('');
  expect(all.split('event: response.created\n').length - 1).toBe(1);
  expect(all.split('event: response.completed\n').length - 1).toBe(1);
  expect(all).not.toContain('resp_2');
  expect(all).not.toContain('item_2');
  expect(all).toContain('"delta":"Hel"');
  expect(all).toContain('"delta":"lo"');
  expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');

  expect(usage.streamResumed).toBe(true);
  expect(usage.streamResumeAttempts).toBe(1);
  expect(usage.streamResumeChars).toBe('Hel'.length);
  expect(usage.totalTokens).toBe(0);
});

test('responses resume retries the 429-rejected continuation creation (Retry-After honored), then stitches', async () => {
  const adapter = new ProtocolAdapter();
  const createCalls: any[] = [];

  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: async (params: any) => {
        createCalls.push(params);

        if (createCalls.length === 1) {
          // 初始流：输出 'Hel' 后中断。
          async function* broken(): AsyncIterable<any> {
            yield createdEvent('resp_1');
            yield messageItemAdded('item_1');
            yield textDelta('item_1', 'Hel');
            throw new Error('upstream connection reset');
          }
          return broken();
        }

        if (createCalls.length === 2) {
          // 第一次续写创建被上游真实 429 + Retry-After: 0.05（50ms）拒绝。
          throw Object.assign(new Error('Rate limit reached'), {
            status: 429,
            headers: new Headers({ 'retry-after': '0.05' }),
          });
        }

        // Retry-After 等待后的第二次续写创建成功。
        async function* continuation(): AsyncIterable<any> {
          yield createdEvent('resp_2');
          yield messageItemAdded('item_2');
          yield textDelta('item_2', 'lo');
          yield completedEvent('resp_2', 'item_2', 'lo');
        }
        return continuation();
      },
    },
  });

  const { reply, frames } = createFakeReply();
  const startedAt = Date.now();
  const usage = await adapter.streamResponse(
    {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'gpt-test',
    },
    'Hi',
    {},
    reply,
    undefined
  );
  const elapsedMs = Date.now() - startedAt;

  // 初始请求 + 被拒的续写创建 + 重试成功的续写创建。
  expect(createCalls).toHaveLength(3);
  // 两次续写创建的 input 完全一致（同一半截文本 + 续写指令）。
  expect(createCalls[2].input).toEqual(createCalls[1].input);
  expect(createCalls[2].tool_choice).toBe('none');

  // 上游 Retry-After（50ms）被真实遵守，而不是立即重试。
  expect(elapsedMs).toBeGreaterThanOrEqual(45);

  const all = frames.join('');
  expect(all.split('event: response.created\n').length - 1).toBe(1);
  expect(all.split('event: response.completed\n').length - 1).toBe(1);
  expect(all).not.toContain('resp_2');
  expect(all).toContain('"delta":"Hel"');
  expect(all).toContain('"delta":"lo"');
  expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');

  expect(usage.streamResumed).toBe(true);
  // streamResumeAttempts = 上游续写请求创建次数：被 429 拒绝的那次 + 重试
  // 成功的那次（初始请求不计），与 journal（createCalls）逐次对账。
  expect(usage.streamResumeAttempts).toBe(2);
  expect(usage.streamResumeAttempts).toBe(createCalls.length - 1);
  expect(usage.streamResumeChars).toBe('Hel'.length);
  expect(usage.totalTokens).toBe(0);
});

/** SDK 风格的中止错误（openai-node 将 fetch 的 AbortError 透传/包装后抛出）。 */
function sdkAbortError(): Error {
  return Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
}

test('responses resume creation carries the client abortSignal: cancelling while awaiting response headers aborts upstream immediately', async () => {
  const adapter = new ProtocolAdapter();
  const controller = new AbortController();
  const createCalls: Array<{ params: any; options: any; promise?: Promise<any> }> = [];

  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: (params: any, options: any) => {
        const call: { params: any; options: any; promise?: Promise<any> } = { params, options };
        createCalls.push(call);

        if (createCalls.length === 1) {
          // 初始流：输出 'Hel' 后中断，触发续写。
          async function* broken(): AsyncIterable<any> {
            yield createdEvent('resp_1');
            yield messageItemAdded('item_1');
            yield textDelta('item_1', 'Hel');
            throw new Error('upstream connection reset');
          }
          call.promise = Promise.resolve(broken());
          return call.promise;
        }

        // 续写创建停在“等响应头”阶段：像真实 SDK 一样把 options.signal 交给
        // fetch——中止会让该 promise 以 AbortError 拒绝；没有 signal 则一直挂着
        // （修复前的行为：上游连接保持到超时/空闲超时）。
        call.promise = new Promise((_resolve, reject) => {
          const signal: AbortSignal | undefined = options?.signal;
          if (signal?.aborted) {
            reject(sdkAbortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(sdkAbortError()), { once: true });
          // 客户端在等待续写响应头（建连等待）时取消。
          setTimeout(() => controller.abort(), 10);
        });
        return call.promise;
      },
    },
  });

  const { reply, frames } = createFakeReply();
  const startedAt = Date.now();
  await expect(
    adapter.streamResponse(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://example.com',
        model: 'gpt-test',
      },
      'Hi',
      {},
      reply,
      controller.signal
    )
  ).rejects.toThrow('upstream connection reset');

  // 不重试（AbortError 不可重试），并立即收尾而不是等心跳/空闲超时。
  expect(createCalls).toHaveLength(2);
  expect(Date.now() - startedAt).toBeLessThan(2000);

  // 回归点：续写请求携带客户端 abortSignal（真实 SDK 会把它交给 fetch）。
  expect(createCalls[1].options?.signal).toBe(controller.signal);
  // 上游“建连等待”确实被中止：挂起的创建请求以 AbortError 拒绝，连接被拆除。
  await expect(createCalls[1].promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
});

test('responses resume stream carries the client abortSignal: cancelling while awaiting continuation events aborts upstream immediately', async () => {
  const adapter = new ProtocolAdapter();
  const controller = new AbortController();
  const createCalls: Array<{ params: any; options: any }> = [];
  let continuationUpstreamAborted = false;

  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: (params: any, options: any) => {
        createCalls.push({ params, options });

        if (createCalls.length === 1) {
          // 初始流：输出 'Hel' 后中断，触发续写。
          async function* broken(): AsyncIterable<any> {
            yield createdEvent('resp_1');
            yield messageItemAdded('item_1');
            yield textDelta('item_1', 'Hel');
            throw new Error('upstream connection reset');
          }
          return broken();
        }

        // 续写流：转发一个增量后停在“等事件”阶段。像真实 SDK 一样，signal 中止
        // 会让流迭代器以 AbortError 拒绝（fetch body reader 被中止）；没有 signal
        // 则一直挂着等事件（修复前的行为：直到 300s 流空闲超时）。
        const signal: AbortSignal | undefined = options?.signal;
        let firstEventEmitted = false;
        const stream: AsyncIterable<any> = {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<any>>((resolve, reject) => {
                  if (!firstEventEmitted) {
                    firstEventEmitted = true;
                    resolve({ value: textDelta('item_2', 'lo'), done: false });
                    return;
                  }
                  if (signal?.aborted) {
                    continuationUpstreamAborted = true;
                    reject(sdkAbortError());
                    return;
                  }
                  signal?.addEventListener(
                    'abort',
                    () => {
                      continuationUpstreamAborted = true;
                      reject(sdkAbortError());
                    },
                    { once: true }
                  );
                  // 客户端在续写流等待下一个事件（流等待）时取消。
                  setTimeout(() => controller.abort(), 20);
                }),
              return: async () => ({ done: true, value: undefined }),
            };
          },
        };
        return Promise.resolve(stream);
      },
    },
  });

  const { reply, frames } = createFakeReply();
  const startedAt = Date.now();
  const failure: any = await adapter
    .streamResponse(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://example.com',
        model: 'gpt-test',
      },
      'Hi',
      {},
      reply,
      controller.signal
    )
    .then(
      () => null,
      (error: any) => error
    );

  // 客户端取消以 AbortError 上抛（路由侧不记成功）。修复前这里会一直挂着。
  expect(failure).toBeTruthy();
  expect(failure.name).toBe('AbortError');

  // 回归点：续写请求携带客户端 abortSignal。
  expect(createCalls).toHaveLength(2);
  expect(createCalls[1].options?.signal).toBe(controller.signal);
  // 上游续写连接确实被立即中止，而不是等空闲超时才终结。
  expect(continuationUpstreamAborted).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2000);

  // 已交付的增量保留；终止序列不合成、不补 [DONE]。
  const all = frames.join('');
  expect(all).toContain('"delta":"Hel"');
  expect(all).toContain('"delta":"lo"');
  expect(all.split('event: response.completed\n').length - 1).toBe(0);
  expect(frames.some((f) => f === 'data: [DONE]\n\n')).toBe(false);
});

test('buildResumeResponsesInput normalizes string input and keeps item order', () => {
  expect(buildResumeResponsesInput('question', 'partial')).toEqual([
    { role: 'user', content: 'question' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: STREAM_RESUME_INSTRUCTION }] },
  ]);

  const items = [{ type: 'message', role: 'user', content: 'hello' }];
  const built = buildResumeResponsesInput(items, 'p');
  expect(built[0]).toBe(items[0]); // 原条目原样透传（浅拷贝数组）
  expect(built).toHaveLength(3);
  expect(buildResumeResponsesInput(undefined, 'p')).toHaveLength(2);
});

test('responses resume is skipped when the system setting is disabled', async () => {
  const { systemConfigDb } = await import('../db/index.js');
  vi.mocked(systemConfigDb.get).mockResolvedValueOnce(undefined);

  const adapter = new ProtocolAdapter();
  const createCalls: any[] = [];
  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: async (params: any) => {
        createCalls.push(params);
        async function* broken(): AsyncIterable<any> {
          yield createdEvent('resp_1');
          yield messageItemAdded('item_1');
          yield textDelta('item_1', 'Hel');
          throw new Error('upstream connection reset');
        }
        return broken();
      },
    },
  });

  const { reply } = createFakeReply();
  await expect(
    adapter.streamResponse(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://example.com',
        model: 'gpt-test',
      },
      'Hi',
      {},
      reply,
      undefined
    )
  ).rejects.toThrow('upstream connection reset');

  // 开关关闭：不发起续写请求。
  expect(createCalls).toHaveLength(1);
});
