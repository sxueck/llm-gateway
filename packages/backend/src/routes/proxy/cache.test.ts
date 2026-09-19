import { describe, expect, it } from 'vitest';

import { requestCache } from '../../services/request-cache.js';
import { checkCacheWithKey, computeLogicalCacheKey, releaseCacheLock, tryAcquireCacheLock, waitForCacheFill } from './cache.js';
import { generateCacheKey } from '../../utils/cache-key-generator.js';

describe('tryAcquireCacheLock', () => {
  it('returns a token on first acquire and null while the lock is held', () => {
    const key = 'lock-basic';
    const owner = tryAcquireCacheLock(key);
    expect(owner).toBeTruthy();
    expect(tryAcquireCacheLock(key)).toBeNull();
    releaseCacheLock(key, owner!);
  });

  it('ignores release from a non-owner and frees on owner release', () => {
    const key = 'lock-owner';
    const owner = tryAcquireCacheLock(key);
    releaseCacheLock(key, 'not-the-owner');
    expect(tryAcquireCacheLock(key)).toBeNull();
    releaseCacheLock(key, owner!);
    expect(tryAcquireCacheLock(key)).toBeTruthy();
  });

  it('lazily evicts a stale lock after its TTL', async () => {
    const key = 'lock-stale';
    expect(tryAcquireCacheLock(key, 5)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const nextOwner = tryAcquireCacheLock(key, 5000);
    expect(nextOwner).toBeTruthy();
    releaseCacheLock(key, nextOwner!);
  });
});

describe('waitForCacheFill', () => {
  it("returns 'filled' once the entry lands in the cache", async () => {
    const key = 'wait-filled';
    tryAcquireCacheLock(key, 5000);
    requestCache.set(key, { ok: true }, {}, 5000);
    const outcome = await waitForCacheFill(key, { maxWaitMs: 1000, pollMs: 5 });
    expect(outcome).toBe('filled');
  });

  it("returns 'released' when the lock expires without a cached entry", async () => {
    const key = 'wait-released';
    tryAcquireCacheLock(key, 10);
    const outcome = await waitForCacheFill(key, { maxWaitMs: 2000, pollMs: 5 });
    expect(outcome).toBe('released');
  });

  it("returns 'timeout' when the holder keeps the lock past the wait budget", async () => {
    const key = 'wait-timeout';
    tryAcquireCacheLock(key, 10_000);
    const outcome = await waitForCacheFill(key, { maxWaitMs: 60, pollMs: 10 });
    expect(outcome).toBe('timeout');
  });
});

describe('requestCache.peek', () => {
  it('sees a fresh entry and misses an expired one without counting stats', () => {
    const key = 'peek-fresh';
    requestCache.set(key, { v: 1 }, {}, 5000);
    expect(requestCache.peek(key)).toBe(true);

    const expiredKey = 'peek-expired';
    requestCache.set(expiredKey, { v: 1 }, {}, 1);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(requestCache.peek(expiredKey)).toBe(false);
        resolve();
      }, 10);
    });
  });
});

const vk = (overrides: Record<string, unknown> = {}) => ({ id: 'vk-1', cache_enabled: 1, ...overrides });
const pristineBody = {
  model: 'glm-4-flash-250414',
  temperature: 0,
  messages: [{ role: 'user', content: '翻译成英文：有志者事竟成。' }],
};

describe('computeLogicalCacheKey', () => {
  it('is deterministic for the same pristine body and virtual key', () => {
    expect(computeLogicalCacheKey(vk(), pristineBody, false, false))
      .toBe(computeLogicalCacheKey(vk(), pristineBody, false, false));
  });

  it('scopes keys per virtual key id', () => {
    expect(computeLogicalCacheKey(vk(), pristineBody, false, false))
      .not.toBe(computeLogicalCacheKey(vk({ id: 'vk-2' }), pristineBody, false, false));
  });

  it('returns null when caching is not applicable', () => {
    expect(computeLogicalCacheKey(vk({ cache_enabled: 0 }), pristineBody, false, false)).toBeNull();
    expect(computeLogicalCacheKey(vk(), pristineBody, true, false)).toBeNull();
    expect(computeLogicalCacheKey(vk(), pristineBody, false, true)).toBeNull();
    expect(computeLogicalCacheKey(vk(), undefined, false, false)).toBeNull();
  });
});

describe('checkCacheWithKey', () => {
  it('is not cacheable without a key or with cache disabled', () => {
    expect(checkCacheWithKey(vk(), null).shouldCache).toBe(false);
    expect(checkCacheWithKey(vk({ cache_enabled: 0 }), 'some-key').shouldCache).toBe(false);
  });

  it('reports a miss (lock/fill eligible) for an unknown key', () => {
    const result = checkCacheWithKey(vk(), 'logical-unknown');
    expect(result.shouldCache).toBe(true);
    expect(result.cacheKey).toBe('logical-unknown');
    expect(result.cached).toBeNull();
  });

  it('returns the entry stored under the logical key', () => {
    const key = computeLogicalCacheKey(vk(), pristineBody, false, false)!;
    requestCache.set(key, { ok: 'logical' }, { 'x-test': '1' }, 5000);
    const result = checkCacheWithKey(vk(), key);
    expect(result.cached?.response).toEqual({ ok: 'logical' });
    expect(result.cached?.headers['x-test']).toBe('1');
  });
});

describe('logical key survives routing-target mutation', () => {
  it('same pristine request hit one entry even though routing rewrote the body', () => {
    const logicalKey = computeLogicalCacheKey(vk(), pristineBody, false, false)!;

    // Smart routing rewrites request.body.model to the selected target before
    // the legacy post-routing key was computed — that split is the bug.
    const routedBodyA = { ...pristineBody, model: 'u2-flash' };
    const routedBodyB = { ...pristineBody, model: 'Ling-3.0-flash', thinking: { type: 'disabled' } };
    expect(generateCacheKey(routedBodyA, 'vk-1')).not.toBe(logicalKey);
    expect(generateCacheKey(routedBodyB, 'vk-1')).not.toBe(logicalKey);

    // Leader fills under the logical key...
    requestCache.set(logicalKey, { choices: [{ message: { content: 'Where there is a will, there is a way.' } }] }, {}, 5000);

    // ...and late lookups (waiter / retry re-entry) resolve the same entry.
    expect(checkCacheWithKey(vk(), logicalKey).cached?.response)
      .toEqual({ choices: [{ message: { content: 'Where there is a will, there is a way.' } }] });
  });
});
