import { describe, expect, it, vi } from 'vitest';

const getStats = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({ apiRequestDb: { getStats } }));
import { dashboardRoutes } from './dashboard.js';

describe('dashboard', () => {
  it('requires authentication and returns only approved aggregate fields', async () => {
    const app = { authenticate: vi.fn(), addHook: vi.fn(), get: vi.fn() };
    await dashboardRoutes(app as any);
    expect(app.addHook).toHaveBeenCalledWith('onRequest', app.authenticate);
    const handler = app.get.mock.calls[0][1];
    getStats.mockResolvedValue({ totalRequests: 4, totalTokens: 20, secret: 'must not escape' });
    const result = await handler({ query: { period: 'all' } }, {});
    expect(result.stats.totalRequests).toBe(4);
    expect(result.stats).not.toHaveProperty('secret');
    expect(getStats).toHaveBeenCalledWith(expect.objectContaining({ startTime: 0 }));
  });
});
