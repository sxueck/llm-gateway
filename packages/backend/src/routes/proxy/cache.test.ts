import { describe, expect, it } from 'vitest';

import { requestCache } from '../../services/request-cache.js';
import { releaseCacheLock, tryAcquireCacheLock, waitForCacheFill } from './cache.js';

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
