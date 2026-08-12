import { describe, expect, it, vi } from 'vitest';

const { getForExport } = vi.hoisted(() => ({ getForExport: vi.fn() }));

vi.mock('../db/index.js', () => ({
  promptSampleDb: { getForExport },
}));

import { promptSampleRoutes } from './prompt-samples.js';

describe('promptSampleRoutes', () => {
  it('exports the JSON contract with an attachment response', async () => {
    getForExport.mockResolvedValue([{
      id: 'sample-1',
      virtual_key_id: 'key-1',
      model: 'gpt-5',
      protocol: 'openai',
      prompt_tokens: 42,
      intent_truncated: 1,
      created_at: 1_700_000_000_000,
      intent_text: 'Explain this error',
    }]);
    const routes = new Map<string, Function>();
    const fastify = {
      authenticate: vi.fn(),
      addHook: vi.fn(),
      get: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
      delete: vi.fn(),
    };
    await promptSampleRoutes(fastify as any);
    const reply = {
      type: vi.fn().mockReturnThis(),
      header: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await routes.get('/export')!({ query: { format: 'json' } }, reply);

    expect(getForExport).toHaveBeenCalledWith({ format: 'json' });
    expect(reply.type).toHaveBeenCalledWith('application/json; charset=utf-8');
    expect(reply.header).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="prompt-samples.json"');
    expect(JSON.parse(reply.send.mock.calls[0][0])).toMatchObject({
      version: '1.0.0',
      total: 1,
      samples: [{
        id: 'sample-1',
        virtualKeyId: 'key-1',
        model: 'gpt-5',
        protocol: 'openai',
        promptTokens: 42,
        intentTruncated: true,
        createdAt: 1_700_000_000_000,
        intentText: 'Explain this error',
      }],
    });
  });
});
