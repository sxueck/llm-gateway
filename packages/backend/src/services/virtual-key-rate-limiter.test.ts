import { beforeEach, expect, test } from 'vitest';

import { virtualKeyRateLimiter } from './virtual-key-rate-limiter.js';

const T0 = 1_000_000;

beforeEach(() => {
  virtualKeyRateLimiter.reset();
});

test('allows requests under the limit and blocks at the limit', () => {
  expect(virtualKeyRateLimiter.check('vk1', 2, T0).allowed).toBe(true);
  expect(virtualKeyRateLimiter.check('vk1', 2, T0 + 1_000).allowed).toBe(true);

  const blocked = virtualKeyRateLimiter.check('vk1', 2, T0 + 2_000);
  expect(blocked.allowed).toBe(false);
  expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
});

test('window slides: the oldest request expiring re-admits', () => {
  virtualKeyRateLimiter.check('vk1', 1, T0);
  expect(virtualKeyRateLimiter.check('vk1', 1, T0 + 30_000).allowed).toBe(false);
  // T0 leaves the 60s window at exactly T0+60_000
  expect(virtualKeyRateLimiter.check('vk1', 1, T0 + 60_000).allowed).toBe(true);
});

test('retryAfterSeconds reflects the oldest accepted request', () => {
  virtualKeyRateLimiter.check('vk1', 1, T0);
  const blocked = virtualKeyRateLimiter.check('vk1', 1, T0 + 50_000);
  expect(blocked.retryAfterSeconds).toBe(10);
});

test('null, zero and non-finite limits are unlimited', () => {
  for (const limit of [null, undefined, 0, Number.NaN] as const) {
    for (let i = 0; i < 5; i++) {
      expect(virtualKeyRateLimiter.check('vk2', limit, T0 + i).allowed).toBe(true);
    }
  }
});

test('keys are isolated from each other', () => {
  virtualKeyRateLimiter.check('vk1', 1, T0);
  expect(virtualKeyRateLimiter.check('vk2', 1, T0).allowed).toBe(true);
  expect(virtualKeyRateLimiter.check('vk1', 1, T0).allowed).toBe(false);
});
