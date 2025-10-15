import crypto from 'crypto';
import { memoryLogger } from './logger.js';

interface CacheEntry {
  response: any;
  headers: Record<string, string>;
  timestamp: number;
  ttl: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

export class RequestCache {
  private cache: Map<string, CacheEntry>;
  private accessOrder: Map<string, number>;
  private stats: CacheStats;
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private accessCounter: number;

  constructor(maxSize: number = 1000, defaultTTL: number = 3600000) {
    this.cache = new Map();
    this.accessOrder = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      evictions: 0
    };
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.accessCounter = 0;
  }

  generateCacheKey(requestBody: any): string {
    const normalizedBody = {
      model: requestBody.model?.trim(),
      messages: requestBody.messages,
      temperature: requestBody.temperature,
      max_tokens: requestBody.max_tokens,
      top_p: requestBody.top_p,
      frequency_penalty: requestBody.frequency_penalty,
      presence_penalty: requestBody.presence_penalty,
      stop: requestBody.stop,
      n: requestBody.n,
    };

    const sortedBody = JSON.stringify(normalizedBody, Object.keys(normalizedBody).sort());
    return crypto.createHash('md5').update(sortedBody).digest('hex');
  }

  set(key: string, response: any, headers: Record<string, string>, ttl?: number): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      response,
      headers,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    });

    this.accessOrder.set(key, ++this.accessCounter);
    this.stats.size = this.cache.size;

    memoryLogger.debug(
      `缓存已存储 | key=${key.substring(0, 8)}... | TTL=${(ttl || this.defaultTTL) / 1000}s | 当前大小=${this.cache.size}`,
      'RequestCache'
    );
  }

  get(key: string): { response: any; headers: Record<string, string> } | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      memoryLogger.debug(
        `缓存已过期 | key=${key.substring(0, 8)}... | 存活时间=${((now - entry.timestamp) / 1000).toFixed(1)}s`,
        'RequestCache'
      );
      return null;
    }

    this.accessOrder.set(key, ++this.accessCounter);
    this.stats.hits++;

    memoryLogger.debug(
      `缓存命中 | key=${key.substring(0, 8)}... | 剩余TTL=${((entry.ttl - (now - entry.timestamp)) / 1000).toFixed(1)}s`,
      'RequestCache'
    );

    return {
      response: entry.response,
      headers: entry.headers
    };
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, accessTime] of this.accessOrder.entries()) {
      if (accessTime < oldestAccess) {
        oldestAccess = accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
      this.stats.evictions++;
      this.stats.size = this.cache.size;
      memoryLogger.debug(
        `LRU 淘汰 | key=${oldestKey.substring(0, 8)}... | 淘汰次数=${this.stats.evictions}`,
        'RequestCache'
      );
    }
  }

  clear(): void {
    const previousSize = this.cache.size;
    this.cache.clear();
    this.accessOrder.clear();
    this.stats.size = 0;
    memoryLogger.info(
      `缓存已清空 | 清除条目数=${previousSize}`,
      'RequestCache'
    );
  }

  getStats(): CacheStats & { hitRate: string } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) : '0.00';
    return {
      ...this.stats,
      hitRate: `${hitRate}%`
    };
  }

  logStats(): void {
    const stats = this.getStats();
    const total = stats.hits + stats.misses;
    if (total > 0) {
      memoryLogger.info(
        `缓存统计 | 命中=${stats.hits} | 未命中=${stats.misses} | 命中率=${stats.hitRate} | 当前大小=${stats.size}/${this.maxSize} | 淘汰次数=${stats.evictions}`,
        'RequestCache'
      );
    }
  }
}

export const requestCache = new RequestCache(1000, 3600000);

