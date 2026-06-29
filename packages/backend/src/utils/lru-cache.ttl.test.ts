import { describe, it, expect, vi } from 'vitest';
import { LRUCache } from './lru-cache.js';

describe('LRUCache TTL', () => {
  it('should expire entries after TTL', async () => {
    const cache = new LRUCache<string, string>({ maxSize: 10, ttl: 50 });
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.has('a')).toBe(false);
  });

  it('should refresh TTL on get when ttlPolicy is sliding', async () => {
    const cache = new LRUCache<string, string>({ maxSize: 10, ttl: 50, ttlPolicy: 'sliding' });
    cache.set('a', '1');
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get('a')).toBe('1');
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get('a')).toBe('1');
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('a')).toBeUndefined();
  });

  it('should NOT refresh TTL on get by default (absolute)', async () => {
    const cache = new LRUCache<string, string>({ maxSize: 10, ttl: 50 });
    cache.set('a', '1');
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get('a')).toBe('1');
    await new Promise((r) => setTimeout(r, 30));
    // absolute：自 set 起累计 60ms 已超过 50ms TTL，即使中途 get 过也照样过期
    expect(cache.get('a')).toBeUndefined();
    expect(cache.has('a')).toBe(false);
  });

  it('should evict expired entries via peek', async () => {
    const cache = new LRUCache<string, string>({ maxSize: 10, ttl: 50 });
    cache.set('a', '1');
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.peek('a')).toBeUndefined();
  });

  it('should call onEvict with ttl reason', async () => {
    const onEvict = vi.fn();
    const cache = new LRUCache<string, string>({ maxSize: 10, ttl: 50, onEvict });
    cache.set('a', '1');
    await new Promise((r) => setTimeout(r, 60));
    cache.get('a');
    expect(onEvict).toHaveBeenCalledWith('a', '1', 'ttl');
  });
});
