import { test, expect } from 'vitest';

import { ProtocolAdapter } from './protocol-adapter.js';

function createReplyStub() {
  const raw: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeHead: (_status: number, _headers: any) => {
      raw.headersSent = true;
    },
    write: (_chunk: any) => true,
    end: () => {
      raw.writableEnded = true;
    },
    once: (_evt: string, _cb: any) => {},
  };

  return { raw } as any;
}

test('ProtocolAdapter.streamResponse passthroughs prompt_cache_key (stream)', async () => {
  const adapter = new ProtocolAdapter();

  let capturedRequestParams: any | undefined;

  (adapter as any).getOpenAIClient = () => ({
    responses: {
      create: async (requestParams: any) => {
        capturedRequestParams = requestParams;

        async function* gen() {
          yield { type: 'response.created', response: { id: 'resp_1' } };
          yield { type: 'response.output_text.delta', delta: { text: 'ok' } };
          yield {
            type: 'response.completed',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
            },
          };
        }

        return gen();
      },
    },
  });

  const reply = createReplyStub();

  await adapter.streamResponse(
    {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com',
      model: 'gpt-5.2',
    },
    [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    {
      prompt_cache_key: 'ses_42e5e5a87ffeIH340Wl8gLbVJt',
      store: false,
    },
    reply,
    undefined
  );

  expect(capturedRequestParams).toBeTruthy();
  expect(capturedRequestParams.prompt_cache_key).toBe('ses_42e5e5a87ffeIH340Wl8gLbVJt');
});
