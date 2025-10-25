import { requestCache } from '../../services/request-cache.js';
import { generateCacheKey } from '../../utils/cache-key-generator.js';

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
  vkDisplay: string
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

