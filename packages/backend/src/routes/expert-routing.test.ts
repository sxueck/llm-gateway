import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getById: vi.fn(), delete: vi.fn() },
  expertRoutingLogDb: { getByConfigId: vi.fn(), getByCategory: vi.fn(), getStatistics: vi.fn(), getRouteStats: vi.fn(), getDifficultyStats: vi.fn(), getClassifierModelStats: vi.fn(), getById: vi.fn() },
  expertRoutingSessionBindingDb: { deleteByConfig: vi.fn() },
  modelDb: { getByExpertRoutingId: vi.fn(), update: vi.fn(), delete: vi.fn(), getById: vi.fn(), getByProviderId: vi.fn() },
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
  const postRoutes = new Map<string, Function>();
  return {
    routes,
    deleteRoutes,
    postRoutes,
    fastify: {
      authenticate: vi.fn(),
      addHook: vi.fn(),
      get: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
      post: vi.fn((path: string, handler: Function) => postRoutes.set(path, handler)),
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

  it('returns difficulty/band distributions and fail-open rate from persisted stats', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getStatistics.mockResolvedValue([
      { classification_result: 'review', count: 10, avg_time: 20 },
    ]);
    mocks.expertRoutingLogDb.getRouteStats.mockResolvedValue([
      { route_source: 'jev', count: 7, avg_prompt_tokens: 10, avg_cleaned_length: 5 },
      { route_source: 'fail_open', count: 1, avg_prompt_tokens: 10, avg_cleaned_length: 5 },
      { route_source: 'fallback', count: 2, avg_prompt_tokens: 10, avg_cleaned_length: 5 },
    ]);
    mocks.expertRoutingLogDb.getDifficultyStats.mockResolvedValue([
      { difficulty: 'high', band: 'high', count: 6, verdict_reused_count: 1, avg_classifier_time_ms: 12 },
      { difficulty: null, band: 'low', count: 4, verdict_reused_count: 0, avg_classifier_time_ms: null },
    ]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response: any = await routes.get('/:id/statistics')!({
      params: { id: 'routing-1' },
      query: {},
    });

    expect(mocks.expertRoutingLogDb.getDifficultyStats).toHaveBeenCalledWith('routing-1', undefined);
    expect(response.difficultyDistribution).toEqual({ high: 6, unclassified: 4 });
    expect(response.bandDistribution).toEqual({ high: 6, low: 4 });
    expect(response.routeSourceDistribution.fail_open).toBe(1);
    expect(response.failOpenRate).toBe(0.3);
    // No actual usage tokens / price mapping are persisted: savings must not be invented.
    expect(response.estimatedSavingVsHighBand).toBeNull();
    expect(response.limitations.some((item: string) => item.includes('estimatedSavingVsHighBand'))).toBe(true);
  });

  it('returns null fail-open rate and empty distributions when no stats rows exist', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getStatistics.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getRouteStats.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getDifficultyStats.mockResolvedValue([]);

    mocks.expertRoutingLogDb.getClassifierModelStats.mockResolvedValue([]);

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response: any = await routes.get('/:id/statistics')!({
      params: { id: 'routing-1' },
      query: {},
    });

    expect(response.totalRequests).toBe(0);
    expect(response.difficultyDistribution).toEqual({});
    expect(response.bandDistribution).toEqual({});
    expect(response.failOpenRate).toBeNull();
  });

  it('returns the v47 difficulty/classifier columns on log details', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
    mocks.expertRoutingLogDb.getById.mockResolvedValue({
      id: 'log-1',
      expert_routing_id: 'routing-1',
      classifier_model: null,
      difficulty: 'medium',
      band: 'medium',
      verdict_reused: 1,
      classifier_time_ms: null,
      route_source: 'session',
    });

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response: any = await routes.get('/:id/logs/:logId/details')!({
      params: { id: 'routing-1', logId: 'log-1' },
    });

    expect(response.difficulty).toBe('medium');
    expect(response.band).toBe('medium');
    expect(response.verdict_reused).toBe(1);
    expect(response.classifier_time_ms).toBeNull();
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
  describe('bands preview', () => {
    const storedExperts = [
      { id: 'cheap', category: 'simple', type: 'real', provider_id: 'prov-1', model: 'cheap-model' },
      { id: 'pricey', category: 'deep', type: 'real', provider_id: 'prov-1', model: 'pricey-model' },
    ];

    beforeEach(() => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        config: JSON.stringify({ experts: storedExperts }),
      });
      mocks.modelDb.getByProviderId.mockImplementation(async (providerId: string) => [
        {
          is_virtual: 0,
          provider_id: providerId,
          model_identifier: 'cheap-model',
          model_attributes: JSON.stringify({ input_cost_per_token: 0.01, output_cost_per_token: 0.03 }),
        },
        {
          is_virtual: 0,
          provider_id: providerId,
          model_identifier: 'pricey-model',
          model_attributes: JSON.stringify({ input_cost_per_token: 0.5, output_cost_per_token: 1.5 }),
        },
      ]);
    });

    it('previews bands for the stored configuration', async () => {
      const { routes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response = await routes.get('/:id/bands/preview')!({ params: { id: 'routing-1' } });

      expect(response.bands.low.map((e: any) => e.id)).toEqual(['cheap']);
      expect(response.bands.medium.map((e: any) => e.id)).toEqual(['pricey']);
      expect(response.bands.low[0].blendedPrice).toBeCloseTo(0.015, 6);
      expect(response.bands.medium[0].blendedPrice).toBeCloseTo(0.75, 6);
      expect(response.assignment).toEqual({ cheap: 'low', pricey: 'medium' });
    });

    it('previews a new configuration before its first save', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);
      const response = await postRoutes.get('/bands/preview')!({
        body: { experts: storedExperts },
      });
      expect(response.assignment).toEqual({ cheap: 'low', pricey: 'medium' });
      expect(mocks.expertRoutingConfigDb.getById).not.toHaveBeenCalled();
    });

    it('previews unsaved experts from the request body over the stored ones', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response = await postRoutes.get('/:id/bands/preview')!({
        params: { id: 'routing-1' },
        body: {
          experts: [
            { id: 'draft-high', category: 'deep', type: 'real', provider_id: 'prov-1', model: 'pricey-model', band: 'high' },
            { id: 'draft-cheap', category: 'simple', type: 'real', provider_id: 'prov-1', model: 'cheap-model' },
          ],
        },
      });

      expect(response.bands.high.map((e: any) => e.id)).toEqual(['draft-high']);
      expect(response.bands.low.map((e: any) => e.id)).toEqual(['draft-cheap']);
      expect(response.assignment).toEqual({ 'draft-high': 'high', 'draft-cheap': 'low' });
      expect(mocks.expertRoutingConfigDb.getById).not.toHaveBeenCalled();
    });

    it('falls back to the stored configuration when the body has no experts', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response = await postRoutes.get('/:id/bands/preview')!({
        params: { id: 'routing-1' },
        body: {},
      });

      expect(response.assignment).toEqual({ cheap: 'low', pricey: 'medium' });
    });

    it('rejects the preview when the configuration does not exist', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue(null);
      const { routes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      await expect(routes.get('/:id/bands/preview')!({ params: { id: 'missing' } }))
        .rejects.toThrow('专家路由配置不存在');
    });
  });
});
