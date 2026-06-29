import { LRUCache } from '../utils/lru-cache.js';
import { virtualKeyDb, modelDb, providerDb } from '../db/index.js';
import type { VirtualKey } from '../types/index.js';
import type { Model } from '../db/types.js';
import type { Provider } from '../types/index.js';

const DEFAULT_TTL_MS = 60_000;

// 注意：缓存值约定为扁平的标量结构（当前 VirtualKey/Model/Provider 均是）。
// 浅拷贝用于隔离调用方对返回值的修改、避免污染缓存内部对象；它不递归拷贝嵌套对象。
// 若将来给这些类型增加嵌套可变字段，需改用 structuredClone 或在写入时深拷贝。
function shallowClone<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    return { ...obj } as T;
  }
  return obj;
}

class HotConfigCacheService {
  private virtualKeyCache = new LRUCache<string, VirtualKey>({
    maxSize: 5000,
    ttl: DEFAULT_TTL_MS,
    ttlPolicy: 'absolute',
  });
  private modelCache = new LRUCache<string, Model>({
    maxSize: 2000,
    ttl: DEFAULT_TTL_MS,
    ttlPolicy: 'absolute',
  });
  private providerCache = new LRUCache<string, Provider>({
    maxSize: 500,
    ttl: DEFAULT_TTL_MS,
    ttlPolicy: 'absolute',
  });

  async getVirtualKeyByKeyValue(keyValue: string): Promise<VirtualKey | undefined> {
    const cached = this.virtualKeyCache.get(keyValue);
    if (cached !== undefined) {
      return shallowClone(cached);
    }
    const result = await virtualKeyDb.getByKeyValue(keyValue);
    if (result !== undefined) {
      this.virtualKeyCache.set(keyValue, shallowClone(result));
    }
    return result;
  }

  async getModelById(id: string): Promise<Model | undefined> {
    const cached = this.modelCache.get(id);
    if (cached !== undefined) {
      return shallowClone(cached);
    }
    const result = await modelDb.getById(id);
    if (result !== undefined) {
      this.modelCache.set(id, shallowClone(result));
    }
    return result;
  }

  async getProviderById(id: string): Promise<Provider | undefined> {
    const cached = this.providerCache.get(id);
    if (cached !== undefined) {
      return shallowClone(cached);
    }
    const result = await providerDb.getById(id);
    if (result !== undefined) {
      this.providerCache.set(id, shallowClone(result));
    }
    return result;
  }

  invalidateVirtualKey(keyValue: string): void {
    this.virtualKeyCache.delete(keyValue);
  }

  invalidateModel(id: string): void {
    this.modelCache.delete(id);
  }

  invalidateProvider(id: string): void {
    this.providerCache.delete(id);
  }

  clear(): void {
    this.virtualKeyCache.clear();
    this.modelCache.clear();
    this.providerCache.clear();
  }
}

export const hotConfigCache = new HotConfigCacheService();
