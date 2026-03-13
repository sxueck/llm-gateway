import { memoryLogger } from './logger.js';

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
  private cache: Map<string, CacheEntry>;
  private accessOrder: Map<string, number>;
  private stats: CacheStats;
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private accessCounter: number;
  
  // 内存限制常量 (50MB 总上限, 100KB 单条上限)
  private readonly maxBytes: number = 50 * 1024 * 1024; // 50MB
  private readonly maxEntryBytes: number = 100 * 1024; // 100KB
  
  // 主动 TTL 清扫定时器
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs: number = 60000; // 每分钟清扫一次

  constructor(maxSize: number = 1000, defaultTTL: number = 3600000) {
    this.cache = new Map();
    this.accessOrder = new Map();
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
    this.accessCounter = 0;
    
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
        this.accessOrder.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.stats.size = this.cache.size;
      this.stats.totalBytes -= cleanedBytes;
      memoryLogger.debug(
        `TTL 清扫完成 | 清理条目=${cleaned} | 释放字节=${cleanedBytes} | 剩余条目=${this.cache.size} | 剩余字节=${this.stats.totalBytes}`,
        'RequestCache'
      );
    }
  }
  
  /**
   * 根据字节限制执行 LRU 淘汰
   * @param requiredBytes 需要的字节数
   * @param excludeKey 需要排除的 key（用于更新场景，避免淘汰正在更新的条目）
   */
  private evictByBytes(requiredBytes: number, excludeKey?: string): void {
    while (this.stats.totalBytes + requiredBytes > this.maxBytes && this.cache.size > 0) {
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;

      for (const [key, accessTime] of this.accessOrder.entries()) {
        // 跳过被排除的 key（更新场景下保护当前条目）
        if (excludeKey && key === excludeKey) {
          continue;
        }
        if (accessTime < oldestAccess) {
          oldestAccess = accessTime;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        const entry = this.cache.get(oldestKey);
        if (entry) {
          this.stats.totalBytes -= entry.size;
          this.stats.bytesEvicted += entry.size;
        }
        this.cache.delete(oldestKey);
        this.accessOrder.delete(oldestKey);
        this.stats.evictions++;
        this.stats.size = this.cache.size;
      } else {
        break; // 无法找到可淘汰的条目（或只有被排除的 key）
      }
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

    const existingEntry = this.cache.get(key);
    const isUpdate = !!existingEntry;
    const oldSize = existingEntry?.size ?? 0;

    // 计算净增字节数（更新时扣除旧大小）
    const netBytesNeeded = isUpdate ? entrySize - oldSize : entrySize;

    // 新条目：检查数量上限
    if (!isUpdate && this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    // 检查总字节上限，执行淘汰（基于净增字节数）
    // 更新场景下传入 excludeKey，避免淘汰正在更新的同一个 key
    if (this.stats.totalBytes + netBytesNeeded > this.maxBytes) {
      this.evictByBytes(netBytesNeeded, isUpdate ? key : undefined);
    }

    // 如果淘汰后仍然超限，放弃缓存
    // 确保 stats.size 与实际 cache.size 同步
    if (this.stats.totalBytes + netBytesNeeded > this.maxBytes) {
      if (isUpdate && existingEntry) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
        this.stats.totalBytes -= oldSize;
      }
      this.stats.size = this.cache.size;
      memoryLogger.debug(
        `缓存跳过 | key=${key.substring(0, 8)}... | 原因=总字节超限且无法淘汰`,
        'RequestCache'
      );
      return;
    }

    // 正式写入缓存
    this.cache.set(key, {
      response,
      headers,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
      size: entrySize
    });

    // 更新字节统计（使用净增字节数）
    this.stats.totalBytes += netBytesNeeded;
    this.accessOrder.set(key, ++this.accessCounter);
    this.stats.size = this.cache.size;

    memoryLogger.debug(
      `缓存已存储 | key=${key.substring(0, 8)}... | TTL=${(ttl || this.defaultTTL) / 1000}s | 条目大小=${entrySize} | 当前条目数=${this.cache.size} | 总字节=${this.stats.totalBytes}`,
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
      this.stats.totalBytes -= entry.size;
      this.cache.delete(key);
      this.accessOrder.delete(key);
      this.stats.size = this.cache.size;
      this.stats.misses++;
      memoryLogger.debug(
        `缓存已过期 | key=${key.substring(0, 8)}... | 存活时间=${((now - entry.timestamp) / 1000).toFixed(1)}s | 释放字节=${entry.size}`,
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
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.stats.totalBytes -= entry.size;
        this.stats.bytesEvicted += entry.size;
      }
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
    const previousBytes = this.stats.totalBytes;
    this.cache.clear();
    this.accessOrder.clear();
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
