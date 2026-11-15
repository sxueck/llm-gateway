import { test, expect, vi } from 'vitest';

// 续写开关走真实 stream-resumer 逻辑：mock DB 返回 enabled。
vi.mock('../db/index.js', () => ({
  systemConfigDb: { get: vi.fn(async () => ({ value: 'true' })) },
}));

import { ProtocolAdapter } from './protocol-adapter.js';
import { STREAM_RESUME_INSTRUCTION } from './stream-resumer.js';

function chunk(id: string, choices: any, usage?: any): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'upstream-model',
    choices,
    ...(usage ? { usage } : {}),
  };
}

test('stream resume retries the continuation request, honoring upstream Retry-After', async () => {
  const adapter = new ProtocolAdapter();
  const createCalls: any[] = [];

  (adapter as any).getOpenAIClient = () => ({
    chat: {
      completions: {
        create: async (params: any) => {
          createCalls.push(params);

          if (createCalls.length === 1) {
            // 初始流：输出 'Hel' 后中断。
            async function* broken(): AsyncIterable<any> {
              yield chunk('id1', [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
              yield chunk('id1', [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }]);
              throw new Error('upstream connection reset');
            }
            return broken();
          }

          if (createCalls.length === 2) {
            // 第一次续写请求被上游 429 拒绝，携带 Retry-After: 0.05（50ms）。
            throw Object.assign(new Error('Rate limit reached'), {
              status: 429,
              headers: new Headers({ 'retry-after': '0.05' }),
            });
          }

          // Retry-After 等待后的第二次续写请求成功。
          async function* continuation(): AsyncIterable<any> {
            yield chunk('id2', [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
            yield chunk('id2', [{ index: 0, delta: { content: 'lo' }, finish_reason: null }]);
            yield chunk('id2', [{ index: 0, delta: {}, finish_reason: 'stop' }]);
            yield chunk('id2', [], { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
          }
          return continuation();
        },
      },
    },
  });

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

  const startedAt = Date.now();
  const usage = await adapter.streamChatCompletion(
    {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'gpt-test',
    },
    [{ role: 'user', content: 'hi' }],
    {},
    { raw } as any,
    undefined
  );
  const elapsedMs = Date.now() - startedAt;

  // 初始请求 + 被拒的续写 + 重试成功的续写。
  expect(createCalls).toHaveLength(3);

  // 续写消息 = 原对话 + 部分输出 + 继续指令；两次续写内容一致。
  const expectedTail = [
    { role: 'assistant', content: 'Hel' },
    { role: 'user', content: STREAM_RESUME_INSTRUCTION },
  ];
  expect(createCalls[1].messages.slice(-2)).toEqual(expectedTail);
  expect(createCalls[2].messages.slice(-2)).toEqual(expectedTail);

  // 上游 Retry-After（50ms）被真实遵守，而不是立即重试。
  expect(elapsedMs).toBeGreaterThanOrEqual(45);

  const all = frames.join('');
  expect(all).toContain('"content":"Hel"');
  expect(all).toContain('"content":"lo"');
  expect(frames[frames.length - 1]).toBe('data: [DONE]\n\n');

  expect(usage.streamResumed).toBe(true);
  // streamResumeAttempts = 上游续写请求创建次数：被 429 拒绝的那次 + Retry-After
  // 后重试成功的那次（初始请求不计），与 journal（createCalls）逐次对账。
  expect(usage.streamResumeAttempts).toBe(2);
  expect(usage.streamResumeAttempts).toBe(createCalls.length - 1);
  expect(usage.streamResumeChars).toBe('Hel'.length);
});

test('non-retryable continuation rejection (400) is not retried and stays terminal', async () => {
  const adapter = new ProtocolAdapter();
  const createCalls: any[] = [];

  (adapter as any).getOpenAIClient = () => ({
    chat: {
      completions: {
        create: async (params: any) => {
          createCalls.push(params);
          if (createCalls.length === 1) {
            async function* broken(): AsyncIterable<any> {
              yield chunk('id1', [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
              yield chunk('id1', [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }]);
              throw new Error('upstream connection reset');
            }
            return broken();
          }
          throw Object.assign(new Error('Invalid request'), {
            status: 400,
            headers: new Headers(),
          });
        },
      },
    },
  });

  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: () => {
      raw.headersSent = true;
    },
    write: () => true,
    end: () => {
      raw.writableEnded = true;
    },
    once: () => {},
  };

  await expect(
    adapter.streamChatCompletion(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://example.com',
        model: 'gpt-test',
      },
      [{ role: 'user', content: 'hi' }],
      {},
      { raw } as any,
      undefined
    )
  ).rejects.toThrow('upstream connection reset');

  // 400 不重试：只有初始请求 + 一次续写尝试。
  expect(createCalls).toHaveLength(2);
  expect(raw.writableEnded).toBe(false);
});
