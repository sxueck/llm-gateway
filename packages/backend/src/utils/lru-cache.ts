export interface LRUCacheOptions<K, V> {
  /** 缓存最大条目数 */
  maxSize?: number;
  /** 缓存最大字节数，如果设置了此项则必须提供 getSize 回调 */
  maxBytes?: number;
  /** 计算条目字节大小的回调函数 */
  getSize?: (value: V, key: K) => number;
  /** 条目因容量限制或过期被淘汰时的回调 */
  onEvict?: (key: K, value: V, reason: 'size' | 'bytes' | 'ttl' | 'delete') => void;
}

/**
 * 通用高性能 LRU 缓存
 * 基于 JS Map 的插入顺序保证 O(1) 的读写和淘汰性能。
 * 替代之前的各种散落的 O(N) 手动实现，统一处理基于条目数或基于字节的 LRU。
 */
export class LRUCache<K, V> {
  protected cache = new Map<K, V>();
  protected _totalBytes = 0;
  
  constructor(protected options: LRUCacheOptions<K, V>) {
    if (options.maxBytes !== undefined && typeof options.getSize !== 'function') {
      throw new Error('LRUCache: maxBytes is specified but getSize function is missing');
    }
  }

  get size(): number { return this.cache.size; }
  get totalBytes(): number { return this._totalBytes; }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * 获取条目，同时将该条目移动到 LRU 队列最前（最新访问）
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // 保证 O(1) 更新访问顺序
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }
  
  /**
   * 不更新访问顺序获取条目
   */
  peek(key: K): V | undefined {
    return this.cache.get(key);
  }

  /**
   * 设置条目。如果超限会触发淘汰（同步）。
   */
  set(key: K, value: V): void {
    const existing = this.cache.get(key);
    let newSizeBytes = 0;
    let oldSizeBytes = 0;
    
    if (this.options.getSize) {
      newSizeBytes = this.options.getSize(value, key);
      if (existing !== undefined) {
        oldSizeBytes = this.options.getSize(existing, key);
      }
    }

    const netBytes = newSizeBytes - oldSizeBytes;

    // 先执行基于字节的淘汰（为新元素腾出空间）
    if (this.options.maxBytes && netBytes > 0) {
      this.evictToFitBytes(netBytes, existing !== undefined ? key : undefined);
    }

    if (existing !== undefined) {
      this.cache.delete(key);
    }

    this.cache.set(key, value);
    this._totalBytes += netBytes;

    // 执行基于条目数量的淘汰
    if (this.options.maxSize !== undefined && this.cache.size > this.options.maxSize) {
      this.evictOne('size');
    }
  }

  /**
   * 删除指定的 key
   */
  delete(key: K): boolean {
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      if (this.options.getSize) {
        this._totalBytes -= this.options.getSize(existing, key);
      }
      this.cache.delete(key);
      if (this.options.onEvict) {
        this.options.onEvict(key, existing, 'delete');
      }
      return true;
    }
    return false;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    const entries = Array.from(this.cache.entries());
    this.cache.clear();
    this._totalBytes = 0;
    
    if (this.options.onEvict) {
      for (const [key, value] of entries) {
        this.options.onEvict(key, value, 'delete');
      }
    }
  }

  /**
   * 淘汰最老的一个条目
   */
  protected evictOne(reason: 'size' | 'bytes', excludeKey?: K): void {
    for (const key of this.cache.keys()) {
      if (excludeKey !== undefined && key === excludeKey) {
        continue;
      }
      const val = this.cache.get(key)!;
      if (this.options.getSize) {
        this._totalBytes -= this.options.getSize(val, key);
      }
      this.cache.delete(key);
      if (this.options.onEvict) {
        this.options.onEvict(key, val, reason);
      }
      break; // 只淘汰一个
    }
  }

  /**
   * 连续淘汰最老的条目直到能容纳指定的净增字节数
   */
  protected evictToFitBytes(netBytesNeeded: number, excludeKey?: K): void {
    if (this.options.maxBytes === undefined) return;
    
    // 如果单个缓存项净增量就大于整体上限，直接清空其它项仍可能不够（上层通常会在存入前拦截超大单项）
    while (this._totalBytes + netBytesNeeded > this.options.maxBytes) {
      // 检查是否还有除了 excludeKey 之外的项可以淘汰
      const effectiveSize = excludeKey !== undefined && this.cache.has(excludeKey) 
        ? this.cache.size - 1 
        : this.cache.size;
        
      if (effectiveSize <= 0) break;
      
      this.evictOne('bytes', excludeKey);
    }
  }

  keys() { return this.cache.keys(); }
  values() { return this.cache.values(); }
  entries() { return this.cache.entries(); }
}
