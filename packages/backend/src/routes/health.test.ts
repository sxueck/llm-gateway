import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTargetRunsPage: vi.fn(),
  getConfig: vi.fn(async () => ({ value: 'true' })),
}));

vi.mock('../db/index.js', () => ({
  healthTargetDb: {},
  systemConfigDb: { get: mocks.getConfig },
}));
vi.mock('../services/health-aggregator.js', () => ({
  healthAggregatorService: { getTargetRunsPage: mocks.getTargetRunsPage },
}));

import { healthRoutes } from './health.js';

describe('public health runs pagination', () => {
  it.each(['/public/health/runs', '/api/public/health/runs'])(
    'rejects invalid pagination and windows before querying on %s',
    async (path) => {
      const app = Fastify();
      app.decorate('authenticate', async () => {});
      await app.register(healthRoutes);
      try {
        mocks.getTargetRunsPage.mockClear();
        for (const [query, code] of [
          ['page=abc', 'invalid_pagination'],
          ['page_size=abc', 'invalid_pagination'],
          ['page=99999999999999999', 'invalid_pagination'],
          ['page=999999999999999&page_size=100', 'invalid_pagination'],
          ['window=foo', 'invalid_window'],
          ['window=', 'invalid_window'],
        ]) {
          const response = await app.inject({ method: 'GET', url: `${path}?target_id=t1&${query}` });
          expect(response.statusCode).toBe(400);
          expect(response.json().error.code).toBe(code);
        }
        expect(mocks.getTargetRunsPage).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each(['/public/health/runs', '/api/public/health/runs'])(
    'passes bounded page and offset to the service on %s',
    async (path) => {
      const app = Fastify();
      app.decorate('authenticate', async () => {});
      await app.register(healthRoutes);
      try {
        mocks.getTargetRunsPage.mockReset().mockResolvedValue({ runs: [{ id: 'r1' }], total: 251 });
        const response = await app.inject({ method: 'GET', url: `${path}?target_id=t1&page=3&page_size=200` });
        expect(response.statusCode).toBe(200);
        expect(mocks.getTargetRunsPage).toHaveBeenCalledWith('t1', {
          window: '24h', limit: 100, offset: 200,
        });
        expect(response.json().pagination).toEqual({ page: 3, pageSize: 100, total: 251, totalPages: 3 });
      } finally {
        await app.close();
      }
    },
  );
});
