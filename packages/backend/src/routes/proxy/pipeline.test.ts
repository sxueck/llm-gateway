import { beforeEach, expect, test, vi } from 'vitest';

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import { runProxyPreflight } from './pipeline.js';

vi.mock('../../services/anti-bot.js', () => ({
  antiBotService: {
    detect: vi.fn(() => ({ shouldBlock: false })),
    logDetection: vi.fn(),
  },
}));

vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: {
    getVirtualKeyByKeyValue: vi.fn(),
  },
}));

const RATE_LIMITED_KEY = 'vk-rate-test';

function makeRequestReply() {
  const request: any = {
    headers: { authorization: `Bearer ${RATE_LIMITED_KEY}` },
    body: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
  return { request, reply };
}

function makeHandlers() {
  return {
    onAntiBotBlock: vi.fn(),
    onAuthError: vi.fn(),
    onRateLimited: vi.fn(
      ({ reply, limitPerMinute, retryAfterSeconds }: any) => {
        reply.code(429).send({
          error: {
            message: `Rate limit exceeded for this virtual key (limit: ${limitPerMinute} requests/min). Retry after ${retryAfterSeconds}s.`,
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        });
      },
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  virtualKeyRateLimiter.reset();
});

test('requests under the configured RPM pass the preflight', async () => {
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    id: 'vk-rl',
    key_value: RATE_LIMITED_KEY,
    enabled: 1,
    rate_limit: 2,
  } as any);
  const { request, reply } = makeRequestReply();
  const handlers = makeHandlers();

  const result = await runProxyPreflight(request, reply, handlers);

  expect(result.ok).toBe(true);
  expect(handlers.onRateLimited).not.toHaveBeenCalled();
  expect(reply.code).not.toHaveBeenCalled();
});

test('requests above the configured RPM get a 429 with Retry-After', async () => {
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    id: 'vk-rl',
    key_value: RATE_LIMITED_KEY,
    enabled: 1,
    rate_limit: 2,
  } as any);
  const handlers = makeHandlers();

  await runProxyPreflight(makeRequestReply().request, makeRequestReply().reply, handlers);
  await runProxyPreflight(makeRequestReply().request, makeRequestReply().reply, handlers);
  const { request, reply } = makeRequestReply();
  const result = await runProxyPreflight(request, reply, handlers);

  expect(result.ok).toBe(false);
  expect(handlers.onRateLimited).toHaveBeenCalledTimes(1);
  expect(reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
  expect(reply.code).toHaveBeenCalledWith(429);
  expect(reply.send).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.objectContaining({
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      }),
    }),
  );
});

test('keys without rate_limit stay unlimited', async () => {
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    id: 'vk-unlimited',
    key_value: RATE_LIMITED_KEY,
    enabled: 1,
    rate_limit: null,
  } as any);

  for (let i = 0; i < 5; i++) {
    const { request, reply } = makeRequestReply();
    const handlers = makeHandlers();
    const result = await runProxyPreflight(request, reply, handlers);
    expect(result.ok).toBe(true);
  }
});
