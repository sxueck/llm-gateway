import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn(), delete: vi.fn() },
  expertRoutingLogDb: { getByConfigId: vi.fn(), getByCategory: vi.fn() },
  expertRoutingSessionBindingDb: { deleteByConfig: vi.fn() },
  modelDb: { getByExpertRoutingId: vi.fn(), update: vi.fn(), delete: vi.fn() },
  virtualKeyDb: { countByModels: vi.fn() },
  invalidateModel: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
  expertRoutingTrainingRecordDb: {},
  modelDb: mocks.modelDb,
  systemConfigDb: {},
  virtualKeyDb: mocks.virtualKeyDb,
}));

vi.mock('../services/hot-config-cache.js', () => ({
  hotConfigCache: { invalidateModel: mocks.invalidateModel },
}));

vi.mock('../services/logger.js', () => ({
  memoryLogger: { error: vi.fn(), info: vi.fn() },
}));

import { expertRoutingRoutes } from './expert-routing.js';

function createFastifyStub() {
  const routes = new Map<string, Function>();
  // Separate map: `routes.delete` would collide with Map.prototype.delete
  const deleteRoutes = new Map<string, Function>();
  return {
    routes,
    deleteRoutes,
    fastify: {
      authenticate: vi.fn(),
      addHook: vi.fn(),
      get: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn((path: string, handler: Function) => deleteRoutes.set(path, handler)),
    } as any,
  };
}

function createReplyStub() {
  const reply: any = {
    statusCode: 200,
    payload: undefined as any,
    code(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.payload = body;
      return reply;
    },
  };
  return reply;
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

  it('infers route_source from legacy classifier_request when route_source is absent', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getByConfigId.mockResolvedValue([{
      id: 'log-legacy',
      expert_routing_id: 'routing-1',
      classifier_model: 'classifier-model',
      classifier_request: 'l1_semantic',
    }]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response = await routes.get('/:id/logs')!({
      params: { id: 'routing-1' },
      query: {},
    });

    expect(response).toEqual({
      logs: [{
        id: 'log-legacy',
        expert_routing_id: 'routing-1',
        classifier_model: 'classifier-model',
        classifier_request: 'l1_semantic',
        route_source: 'l1_semantic',
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

  it('refuses deletion while the expert model is referenced by virtual keys', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.modelDb.getByExpertRoutingId.mockResolvedValue([{
      id: 'expert-model-1',
      is_virtual: 1,
      provider_id: null,
      model_identifier: 'expert-routing-1',
      name: 'Expert model',
    }, {
      id: 'real-model-1',
      is_virtual: 0,
      provider_id: 'prov-1',
      model_identifier: 'gpt-4o',
      name: 'Real model',
    }]);
    mocks.virtualKeyDb.countByModels.mockResolvedValue(new Map([['expert-model-1', 1]]));

    const { deleteRoutes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const reply = createReplyStub();
    await deleteRoutes.get('/:id')!({ params: { id: 'routing-1' } }, reply);

    expect(mocks.virtualKeyDb.countByModels).toHaveBeenCalledWith([{
      id: 'expert-model-1',
      provider_id: null,
      model_identifier: 'expert-routing-1',
      name: 'Expert model',
    }]);
    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toMatchObject({ error: expect.stringContaining('仍被虚拟密钥引用') });
    expect(mocks.expertRoutingConfigDb.delete).not.toHaveBeenCalled();
    expect(mocks.modelDb.delete).not.toHaveBeenCalled();
    expect(mocks.modelDb.update).not.toHaveBeenCalled();
    expect(mocks.expertRoutingSessionBindingDb.deleteByConfig).not.toHaveBeenCalled();
  });

  it('deletes the expert model and detaches other models when unreferenced', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.modelDb.getByExpertRoutingId.mockResolvedValue([{
      id: 'expert-model-1',
      is_virtual: 1,
      provider_id: null,
      model_identifier: 'expert-routing-1',
      name: 'Expert model',
    }, {
      id: 'real-model-1',
      is_virtual: 0,
      provider_id: 'prov-1',
      model_identifier: 'gpt-4o',
      name: 'Real model',
    }]);
    mocks.virtualKeyDb.countByModels.mockResolvedValue(new Map([['expert-model-1', 0]]));
    mocks.expertRoutingConfigDb.delete.mockResolvedValue(undefined);
    mocks.expertRoutingSessionBindingDb.deleteByConfig.mockResolvedValue(0);

    const { deleteRoutes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const reply = createReplyStub();
    const response = await deleteRoutes.get('/:id')!({ params: { id: 'routing-1' } }, reply);

    expect(mocks.modelDb.delete).toHaveBeenCalledWith('expert-model-1');
    expect(mocks.modelDb.update).toHaveBeenCalledWith('real-model-1', { expert_routing_id: null });
    expect(mocks.invalidateModel).toHaveBeenCalledWith('expert-model-1');
    expect(mocks.expertRoutingConfigDb.delete).toHaveBeenCalledWith('routing-1');
    expect(reply.statusCode).toBe(200);
    expect(response).toEqual({ success: true });
  });
});
