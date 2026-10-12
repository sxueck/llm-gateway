import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hotConfigCache } from './hot-config-cache.js';
import { virtualKeyDb, modelDb, providerDb } from '../db/index.js';

vi.mock('../db/index.js', () => ({
  virtualKeyDb: {
    getByKeyValue: vi.fn(),
  },
  modelDb: {
    getById: vi.fn(),
  },
  providerDb: {
    getById: vi.fn(),
  },
}));

describe('HotConfigCache', () => {
  beforeEach(() => {
    hotConfigCache.clear();
    vi.clearAllMocks();
  });

  describe('virtual key cache', () => {
    it('should hit cache on second read', async () => {
      const key = { id: 'vk1', key_value: 'secret', enabled: 1 } as any;
      vi.mocked(virtualKeyDb.getByKeyValue).mockResolvedValue(key);

      const r1 = await hotConfigCache.getVirtualKeyByKeyValue('secret');
      expect(r1).toEqual(key);
      expect(virtualKeyDb.getByKeyValue).toHaveBeenCalledTimes(1);

      const r2 = await hotConfigCache.getVirtualKeyByKeyValue('secret');
      expect(r2).toEqual(key);
      expect(virtualKeyDb.getByKeyValue).toHaveBeenCalledTimes(1);
    });

    it('should miss after invalidation', async () => {
      const key = { id: 'vk1', key_value: 'secret', enabled: 1 } as any;
      vi.mocked(virtualKeyDb.getByKeyValue).mockResolvedValue(key);

      await hotConfigCache.getVirtualKeyByKeyValue('secret');
      hotConfigCache.invalidateVirtualKey('secret');
      await hotConfigCache.getVirtualKeyByKeyValue('secret');

      expect(virtualKeyDb.getByKeyValue).toHaveBeenCalledTimes(2);
    });

    it('should return shallow clone on cache hit', async () => {
      const key = { id: 'vk1', key_value: 'secret', enabled: 1, nested: { a: 1 } } as any;
      vi.mocked(virtualKeyDb.getByKeyValue).mockResolvedValue(key);

      const r1 = await hotConfigCache.getVirtualKeyByKeyValue('secret');
      const r2 = await hotConfigCache.getVirtualKeyByKeyValue('secret');
      expect(r1).not.toBe(r2);
      expect(r1).toEqual(r2);
    });
  });

  const cacheFamilies = [
    {
      kind: 'model cache',
      entity: { id: 'm1', name: 'gpt-4' } as any,
      read: () => hotConfigCache.getModelById('m1'),
      dbCallCount: () => vi.mocked(modelDb.getById).mock.calls.length,
      mockDb: (entity: any) => vi.mocked(modelDb.getById).mockResolvedValue(entity),
      invalidate: () => hotConfigCache.invalidateModel('m1'),
    },
    {
      kind: 'provider cache',
      entity: { id: 'p1', name: 'openai' } as any,
      read: () => hotConfigCache.getProviderById('p1'),
      dbCallCount: () => vi.mocked(providerDb.getById).mock.calls.length,
      mockDb: (entity: any) => vi.mocked(providerDb.getById).mockResolvedValue(entity),
      invalidate: () => hotConfigCache.invalidateProvider('p1'),
    },
  ];
  it('model/provider caches hit on second read and miss after invalidation', async () => {
    for (const { entity, read, dbCallCount, mockDb, invalidate } of cacheFamilies) {
      mockDb(entity);

      const r1 = await read();
      expect(r1).toEqual(entity);
      expect(dbCallCount()).toBe(1);

      const r2 = await read();
      expect(r2).toEqual(entity);
      expect(dbCallCount()).toBe(1);

      invalidate();
      await read();
      expect(dbCallCount()).toBe(2);
    }
  });
});
