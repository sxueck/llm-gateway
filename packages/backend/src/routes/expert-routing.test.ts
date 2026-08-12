import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn() },
  expertRoutingLogDb: { getByConfigId: vi.fn(), getByCategory: vi.fn() },
}));

vi.mock('../db/index.js', () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  expertRoutingSessionBindingDb: {},
  expertRoutingTrainingRecordDb: {},
  modelDb: {},
  systemConfigDb: {},
}));

vi.mock('../services/hot-config-cache.js', () => ({
  hotConfigCache: {},
}));

vi.mock('../services/logger.js', () => ({
  memoryLogger: { error: vi.fn(), info: vi.fn() },
}));

import { expertRoutingRoutes } from './expert-routing.js';

function createFastifyStub() {
  const routes = new Map<string, Function>();
  return {
    routes,
    fastify: {
      authenticate: vi.fn(),
      addHook: vi.fn(),
      get: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as any,
  };
}

describe('expertRoutingRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through the stored route_source on the logs list endpoint', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getByConfigId.mockResolvedValue([{
      id: 'log-1',
      expert_routing_id: 'routing-1',
      classifier_model: 'classifier-model',
      route_source: 'llm_second_pass',
    }]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response = await routes.get('/:id/logs')!({
      params: { id: 'routing-1' },
      query: { limit: '50' },
    });

    expect(mocks.expertRoutingLogDb.getByConfigId).toHaveBeenCalledWith('routing-1', 50);
    expect(response).toEqual({
      logs: [{
        id: 'log-1',
        expert_routing_id: 'routing-1',
        classifier_model: 'classifier-model',
        route_source: 'llm_second_pass',
        semantic_score: undefined,
      }],
    });
  });

  it('infers route_source via classifier_model when the stored value is absent', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getByConfigId.mockResolvedValue([{
      id: 'log-1',
      expert_routing_id: 'routing-1',
      classifier_model: 'classifier-model',
    }]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response = await routes.get('/:id/logs')!({
      params: { id: 'routing-1' },
      query: {},
    });

    expect(response).toEqual({
      logs: [{
        id: 'log-1',
        expert_routing_id: 'routing-1',
        classifier_model: 'classifier-model',
        route_source: 'llm',
        semantic_score: undefined,
      }],
    });
  });

  it('returns logs by category with route_source passthrough', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getByCategory.mockResolvedValue([{
      id: 'log-2',
      expert_routing_id: 'routing-1',
      classifier_model: 'fallback',
      route_source: 'fallback',
    }]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response = await routes.get('/:id/logs/category/:category')!({
      params: { id: 'routing-1', category: 'general' },
      query: { limit: '10' },
    });

    expect(mocks.expertRoutingLogDb.getByCategory).toHaveBeenCalledWith('routing-1', 'general', 10);
    expect(response).toEqual({
      logs: [{
        id: 'log-2',
        expert_routing_id: 'routing-1',
        classifier_model: 'fallback',
        route_source: 'fallback',
        semantic_score: undefined,
      }],
    });
  });
});
