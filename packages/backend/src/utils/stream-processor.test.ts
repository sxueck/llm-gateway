import { test, expect } from 'vitest';

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
