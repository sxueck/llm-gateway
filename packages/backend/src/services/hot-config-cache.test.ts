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

  describe('model cache', () => {
    it('should hit cache on second read', async () => {
      const model = { id: 'm1', name: 'gpt-4' } as any;
      vi.mocked(modelDb.getById).mockResolvedValue(model);

      const r1 = await hotConfigCache.getModelById('m1');
      expect(r1).toEqual(model);
      expect(modelDb.getById).toHaveBeenCalledTimes(1);

      const r2 = await hotConfigCache.getModelById('m1');
      expect(r2).toEqual(model);
      expect(modelDb.getById).toHaveBeenCalledTimes(1);
    });

    it('should miss after invalidation', async () => {
      const model = { id: 'm1', name: 'gpt-4' } as any;
      vi.mocked(modelDb.getById).mockResolvedValue(model);

      await hotConfigCache.getModelById('m1');
      hotConfigCache.invalidateModel('m1');
      await hotConfigCache.getModelById('m1');

      expect(modelDb.getById).toHaveBeenCalledTimes(2);
    });
  });

  describe('provider cache', () => {
    it('should hit cache on second read', async () => {
      const provider = { id: 'p1', name: 'openai' } as any;
      vi.mocked(providerDb.getById).mockResolvedValue(provider);

      const r1 = await hotConfigCache.getProviderById('p1');
      expect(r1).toEqual(provider);
      expect(providerDb.getById).toHaveBeenCalledTimes(1);

      const r2 = await hotConfigCache.getProviderById('p1');
      expect(r2).toEqual(provider);
      expect(providerDb.getById).toHaveBeenCalledTimes(1);
    });

    it('should miss after invalidation', async () => {
      const provider = { id: 'p1', name: 'openai' } as any;
      vi.mocked(providerDb.getById).mockResolvedValue(provider);

      await hotConfigCache.getProviderById('p1');
      hotConfigCache.invalidateProvider('p1');
      await hotConfigCache.getProviderById('p1');

      expect(providerDb.getById).toHaveBeenCalledTimes(2);
    });
  });
});
