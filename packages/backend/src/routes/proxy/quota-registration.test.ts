import { describe, expect, it, vi } from 'vitest';

vi.mock('./model-handlers.js', () => ({ getModelsHandler: vi.fn(), getModelInfoHandler: vi.fn() }));
vi.mock('./quota-handlers.js', () => ({ getQuotaSummaryHandler: vi.fn() }));
vi.mock('./cloud-handlers.js', () => ({ getCloudModelAttributesHandler: vi.fn() }));
vi.mock('./cache.js', () => ({ startCacheStatsLogger: vi.fn() }));
vi.mock('../../services/logger.js', () => ({ memoryLogger: { debug: vi.fn(), error: vi.fn() } }));

import { proxyRoutes } from './index.js';
import { getQuotaSummaryHandler } from './quota-handlers.js';

describe('quota route registration', () => {
  it('registers the self-service endpoint with and without the v1 prefix', async () => {
    const get = vi.fn();
    await proxyRoutes({ get } as any);
    expect(get).toHaveBeenCalledWith('/v1/quota', getQuotaSummaryHandler);
    expect(get).toHaveBeenCalledWith('/quota', getQuotaSummaryHandler);
  });
});
