import { describe, expect, test } from 'vitest';

import { processOpenAIResponsesStreamToSseWithRetry } from './responses-stream-processor.js';
import { StreamTruncatedError } from './stream-guards.js';

function createReply() {
  const written: string[] = [];
  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: () => {
      raw.headersSent = true;
    },
    write: (chunk: any) => {
      written.push(String(chunk));
      return true;
    },
    end: () => {
      raw.writableEnded = true;
    },
  };
  return { reply: { raw } as any, written };
}

function clientReturning(events: any[]) {
  return {
    responses: {
      create: async () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
    },
  };
}

const TEXT_DELTA = { type: 'response.output_text.delta', delta: 'hi' };
const COMPLETED = {
  type: 'response.completed',
  response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

function run(client: any, reply: any, overrides: Record<string, any> = {}) {
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

describe('processOpenAIResponsesStreamToSseWithRetry', () => {
  test('completes when a terminal event arrives', async () => {
    const { reply, written } = createReply();
    const result = await run(clientReturning([TEXT_DELTA, COMPLETED]), reply);
    expect(result.totalTokens).toBe(2);
    expect(written.join('')).toContain('data: [DONE]');
  });

  test('fails a stream that ends after output without a terminal event', async () => {
    const { reply, written } = createReply();
    await expect(run(clientReturning([TEXT_DELTA]), reply)).rejects.toBeInstanceOf(StreamTruncatedError);
    expect(written.join('')).not.toContain('data: [DONE]');
  });

  test('a start that never completes fails with 504 instead of a cancellation', async () => {
    const { reply } = createReply();
    const client = {
      responses: {
        create: (_params: any, options: any) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
          }),
      },
    };
    await expect(run(client, reply, { initTimeoutMs: 20 })).rejects.toMatchObject({ status: 504 });
  });

  test('a silent stream is cut off by the idle timeout', async () => {
    const { reply } = createReply();
    const client = {
      responses: {
        create: async (_params: any, options: any) => ({
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              next: () => {
                if (!sent) {
                  sent = true;
                  return Promise.resolve({ done: false, value: TEXT_DELTA });
                }
                return new Promise((resolve) => {
                  options.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }));
                });
              },
              return: async () => ({ done: true, value: undefined }),
            };
          },
        }),
      },
    };
    await expect(run(client, reply, { streamIdleTimeoutMs: 20 })).rejects.toMatchObject({ status: 504 });
  });
});
