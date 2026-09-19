import crypto from 'crypto';

import { requestCache } from '../../services/request-cache.js';
import { generateCacheKey } from '../../utils/cache-key-generator.js';
import { memoryLogger } from '../../services/logger.js';

export interface CacheCheckResult {
  shouldCache: boolean;
  cacheKey: string | null;
  cached: any | null;
}

export function checkCache(
  virtualKey: any,
  isStreamRequest: boolean,
  isEmbeddingsRequest: boolean,
  requestBody: any,
  _vkDisplay: string
): CacheCheckResult {
  const shouldCache = virtualKey.cache_enabled === 1 && !isStreamRequest && !isEmbeddingsRequest && requestBody;

  if (!shouldCache) {
    return {
      shouldCache: false,
      cacheKey: null,
      cached: null
    };
  }

  const cacheKey = generateCacheKey(requestBody, virtualKey.id);
  const cached = requestCache.get(cacheKey);

  return {
    shouldCache: true,
    cacheKey,
    cached
  };
}

/**
 * Logical cache key computed from the PRISTINE client request body, called in
 * the route's afterAuth hook — before model resolution / smart routing can
 * rewrite request.body (model, reasoning_effort, thinking, token caps). Keeps
 * one logical request on exactly one cache key regardless of routing target.
 */
export function computeLogicalCacheKey(
  virtualKey: any,
  requestBody: any,
  isStreamRequest: boolean,
  bypassGatewayCache: boolean
): string | null {
  const eligible = virtualKey?.cache_enabled === 1 && !isStreamRequest && !bypassGatewayCache && requestBody;
  return eligible ? generateCacheKey(requestBody, virtualKey.id) : null;
}

/**
 * Cache lookup against a precomputed logical key. Used by the non-stream
 * handler (and its smart-routing retry re-entry) so late lookups never
 * regenerate a key from the routing-mutated body.
 */
export function checkCacheWithKey(virtualKey: any, cacheKey: string | null): CacheCheckResult {
  if (!cacheKey || virtualKey?.cache_enabled !== 1) {
    return { shouldCache: false, cacheKey: null, cached: null };
  }
  return { shouldCache: true, cacheKey, cached: requestCache.get(cacheKey) };
}

/**
 * Stats-free existence probe for the early (afterAuth) lookup: a probe miss
 * must not touch hit/miss counters — the authoritative count happens in
 * handleNonStreamRequest. Only a probe hit triggers the counting lookup.
 */
export function hasCachedEntry(cacheKey: string | null): boolean {
  return !!cacheKey && requestCache.peek(cacheKey);
}

export function setCacheIfNeeded(
  cacheKey: string | null,
  shouldCache: boolean,
  fromCache: boolean,
  responseData: any,
  responseHeaders: Record<string, string>
): void {
  if (cacheKey && shouldCache && !fromCache) {
    const cacheHeaders: Record<string, string> = { ...responseHeaders };
    requestCache.set(cacheKey, responseData, cacheHeaders);
  }
}

export function getCacheStatus(fromCache: boolean, shouldCache: boolean): string {
  if (fromCache) {
    return 'cache hit';
  } else if (shouldCache) {
    return 'cache miss';
  } else {
    return 'cache disabled';
  }
}

export function startCacheStatsLogger(): void {
  setInterval(() => {
    requestCache.logStats();
  }, 3600000);
}

// ─── Cache lock (single-flight lite, nginx proxy_cache_lock style) ───────────
// When several identical non-stream requests race on a cold cache entry, only
// one goes upstream; the others poll for the filled entry instead of stampeding
// the provider (which otherwise triggers upstream 429s on burst traffic).

const CACHE_LOCK_WAIT_MS = parseInt(process.env.CACHE_LOCK_WAIT_MS || '30000', 10);
const CACHE_LOCK_POLL_MS = parseInt(process.env.CACHE_LOCK_POLL_MS || '200', 10);
const CACHE_LOCK_TTL_MS = parseInt(process.env.CACHE_LOCK_TTL_MS || '60000', 10);

interface CacheLock {
  owner: string;
  expiresAt: number;
}

const cacheLocks = new Map<string, CacheLock>();

/**
 * Try to become the request that fills the cache entry for `key`.
 * Returns the owner token on success, or null when another request holds
 * an unexpired lock. A stale lock (holder crashed without release) is
 * evicted lazily here.
 */
export function tryAcquireCacheLock(key: string, ttlMs: number = CACHE_LOCK_TTL_MS): string | null {
  const now = Date.now();
  const existing = cacheLocks.get(key);
  if (existing && existing.expiresAt > now) {
    return null;
  }

  const owner = crypto.randomBytes(8).toString('hex');
  cacheLocks.set(key, { owner, expiresAt: now + ttlMs });
  memoryLogger.debug(`Cache lock acquired | key=${key.substring(0, 8)}... | ttl=${ttlMs}ms`, 'RequestCache');
  return owner;
}

/** Release the lock only if `owner` still holds it (no-op otherwise). */
export function releaseCacheLock(key: string, owner: string): void {
  const existing = cacheLocks.get(key);
  if (existing && existing.owner === owner) {
    cacheLocks.delete(key);
    memoryLogger.debug(`Cache lock released | key=${key.substring(0, 8)}...`, 'RequestCache');
  }
}

/**
 * Wait until the entry for `key` lands in the cache ('filled'), its lock
 * disappears without a cached result ('released' — holder failed, a waiter
 * may take over), or the wait budget runs out ('timeout' — proceed unlocked;
 * degrades to pre-lock behavior).
 */
export async function waitForCacheFill(
  key: string,
  opts?: { maxWaitMs?: number; pollMs?: number }
): Promise<'filled' | 'released' | 'timeout'> {
  const maxWaitMs = opts?.maxWaitMs ?? CACHE_LOCK_WAIT_MS;
  const pollMs = opts?.pollMs ?? CACHE_LOCK_POLL_MS;
  const deadline = Date.now() + maxWaitMs;

  let outcome: 'filled' | 'released' | 'timeout' = 'timeout';
  while (Date.now() < deadline) {
    if (requestCache.peek(key)) {
      outcome = 'filled';
      break;
    }
    const lock = cacheLocks.get(key);
    if (!lock || lock.expiresAt <= Date.now()) {
      outcome = 'released';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }

  memoryLogger.info(
    `Cache lock wait | key=${key.substring(0, 8)}... | result=${outcome} | elapsed=${maxWaitMs - Math.max(0, deadline - Date.now())}ms`,
    'RequestCache'
  );
  return outcome;
}

