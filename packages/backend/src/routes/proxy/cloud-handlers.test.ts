import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getCloudModelAttributesHandler } from './cloud-handlers.js';
import { upstreamFetch } from '../../utils/upstream-fetch.js';

vi.mock('../../utils/upstream-fetch.js', () => ({
  upstreamFetch: vi.fn(),
}));

vi.mock('../../services/logger.js', () => ({
  memoryLogger: {
    error: vi.fn(),
  },
}));

type ReplyState = {
  statusCode?: number;
  headers: Record<string, string>;
  payload?: unknown;
};

type TestReply = {
  code(statusCode: number): TestReply;
  header(name: string, value: string): TestReply;
  send(payload: unknown): TestReply;
};

function createReply(): { reply: FastifyReply; state: ReplyState } {
  const state: ReplyState = { headers: {} };
  const reply: TestReply = {
    code(statusCode: number) {
      state.statusCode = statusCode;
      return this;
    },
    header(name: string, value: string) {
      state.headers[name] = value;
      return this;
    },
    send(payload: unknown) {
      state.payload = payload;
      return this;
    },
  };

  return { reply: reply as unknown as FastifyReply, state };
}

describe('getCloudModelAttributesHandler', () => {
  it('forwards the models.dev response body and status', async () => {
    const body = '{"gpt-4o":{"name":"GPT-4o"}}';
    vi.mocked(upstreamFetch).mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { reply, state } = createReply();

    await getCloudModelAttributesHandler({} as FastifyRequest, reply);

    expect(vi.mocked(upstreamFetch)).toHaveBeenCalledWith('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'llm-gateway/0.2 (model-attributes)',
      },
    });
    expect(state.statusCode).toBe(200);
    expect(state.headers['content-type']).toBe('application/json');
    expect(state.payload).toEqual(Buffer.from(body));
  });

  it('preserves non-success upstream responses', async () => {
    const body = 'upstream unavailable';
    vi.mocked(upstreamFetch).mockResolvedValueOnce(
      new Response(body, {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const { reply, state } = createReply();

    await getCloudModelAttributesHandler({} as FastifyRequest, reply);

    expect(state.statusCode).toBe(503);
    expect(state.headers['content-type']).toBe('text/plain');
    expect(state.payload).toEqual(Buffer.from(body));
  });
});
