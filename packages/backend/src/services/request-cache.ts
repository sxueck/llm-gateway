import { memoryLogger } from './logger.js';
import { LRUCache } from '../utils/lru-cache.js';

interface CacheEntry {
  response: any;
  headers: Record<string, string>;
  timestamp: number;
  ttl: number;
  size: number; // 缓存条目字节大小
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
  totalBytes: number; // 当前总字节数
  bytesEvicted: number; // 因字节限制淘汰的总字节数
}

export class RequestCache {
  private cache: LRUCache<string, CacheEntry>;
  private stats: CacheStats;
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  
  // 内存限制常量 (50MB 总上限, 100KB 单条上限)
  private readonly maxBytes: number = 50 * 1024 * 1024; // 50MB
  private readonly maxEntryBytes: number = 100 * 1024; // 100KB
  
  // 主动 TTL 清扫定时器
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs: number = 60000; // 每分钟清扫一次

  constructor(maxSize: number = 1000, defaultTTL: number = 3600000) {
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      evictions: 0,
      totalBytes: 0,
      bytesEvicted: 0
    };
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;

    this.cache = new LRUCache<string, CacheEntry>({
      maxSize,
      maxBytes: this.maxBytes,
      getSize: (value) => value.size,
      onEvict: (key, value, reason) => {
        if (reason === 'bytes' || reason === 'size') {
          this.stats.evictions++;
          this.stats.bytesEvicted += value.size;
          memoryLogger.debug(
            `LRU 淘汰 | key=${key.substring(0, 8)}... | 淘汰原因=${reason} | 淘汰次数=${this.stats.evictions}`,
            'RequestCache'
          );
        }
      }
    });
    
    // 启动主动 TTL 清扫
    this.startCleanupTimer();
  }
  
  /**
   * 计算响应数据的近似字节大小
   */
  private calculateEntrySize(response: any, headers: Record<string, string>): number {
    let size = 0;
    
    // 计算响应体大小
    if (typeof response === 'string') {
      size += Buffer.byteLength(response, 'utf8');
    } else if (Buffer.isBuffer(response)) {
      size += response.length;
    } else if (response !== null && response !== undefined) {
      // 对象转 JSON 字符串计算
      try {
        size += Buffer.byteLength(JSON.stringify(response), 'utf8');
      } catch {
        size += 1024; // 无法序列化时估算
      }
    }
    
    // 计算 headers 大小
    for (const [key, value] of Object.entries(headers)) {
      size += Buffer.byteLength(key, 'utf8');
      size += Buffer.byteLength(value, 'utf8');
    }
    
    // 基础条目开销 (timestamp, ttl 等字段)
    size += 64;
    
    return size;
  }
  
  /**
   * 检查条目是否超过单条体积上限
   */
  private isEntryTooLarge(entrySize: number): boolean {
    return entrySize > this.maxEntryBytes;
  }
  
  /**
   * 启动主动 TTL 清扫定时器
   */
  private startCleanupTimer(): void {
    if (this.cleanupInterval) {
      return;
    }
    
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredEntries();
    }, this.cleanupIntervalMs);
    
    // 确保定时器不会阻止进程退出
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.clear();
  }
  
  /**
   * 清理所有过期条目
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    let cleaned = 0;
    let cleanedBytes = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        cleanedBytes += entry.size;
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.stats.size = this.cache.size;
      this.stats.totalBytes = this.cache.totalBytes;
      memoryLogger.debug(
        `TTL 清扫完成 | 清理条目=${cleaned} | 释放字节=${cleanedBytes} | 剩余条目=${this.cache.size} | 剩余字节=${this.stats.totalBytes}`,
        'RequestCache'
      );
    }
  }

  set(key: string, response: any, headers: Record<string, string>, ttl?: number): void {
    // 计算条目大小
    const entrySize = this.calculateEntrySize(response, headers);

    // 检查单条是否超过体积上限，超大响应不进入缓存
    if (this.isEntryTooLarge(entrySize)) {
      memoryLogger.debug(
        `缓存跳过 | key=${key.substring(0, 8)}... | 原因=单条超限(${entrySize} > ${this.maxEntryBytes})`,
        'RequestCache'
      );
      return;
    }

    const newEntry: CacheEntry = {
      response,
      headers,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
      size: entrySize
    };

    this.cache.set(key, newEntry);
    this.stats.size = this.cache.size;
    this.stats.totalBytes = this.cache.totalBytes;

    memoryLogger.debug(
      `缓存已设置 | key=${key.substring(0, 8)}... | 字节=${entrySize} | TTL=${newEntry.ttl/1000}s`,
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
      this.stats.size = this.cache.size;
      this.stats.totalBytes = this.cache.totalBytes;
      this.stats.misses++;
      memoryLogger.debug(
        `缓存已过期 | key=${key.substring(0, 8)}... | 存活时间=${((now - entry.timestamp) / 1000).toFixed(1)}s | 释放字节=${entry.size}`,
        'RequestCache'
      );
      return null;
    }

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

  clear(): void {
    const previousSize = this.cache.size;
    const previousBytes = this.cache.totalBytes;
    this.cache.clear();
    this.stats.size = 0;
    this.stats.totalBytes = 0;
    memoryLogger.info(
      `缓存已清空 | 清除条目数=${previousSize} | 释放字节=${previousBytes}`,
      'RequestCache'
    );
  }

  getStats(): CacheStats & { hitRate: string; maxBytes: number; maxEntryBytes: number } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) : '0.00';
    return {
      ...this.stats,
      size: this.cache.size,
      totalBytes: this.cache.totalBytes,
      hitRate: `${hitRate}%`,
      maxBytes: this.maxBytes,
      maxEntryBytes: this.maxEntryBytes
    };
  }

  logStats(): void {
    const stats = this.getStats();
    const total = stats.hits + stats.misses;
    if (total > 0) {
      memoryLogger.info(
        `缓存统计 | 命中=${stats.hits} | 未命中=${stats.misses} | 命中率=${stats.hitRate} | 条目数=${stats.size}/${this.maxSize} | 字节=${stats.totalBytes}/${this.maxBytes} | 淘汰次数=${stats.evictions} | 淘汰字节=${stats.bytesEvicted}`,
        'RequestCache'
      );
    }
  }
}

export const requestCache = new RequestCache(1000, 3600000);
