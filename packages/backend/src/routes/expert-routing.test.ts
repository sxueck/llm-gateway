import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expertRoutingConfigDb: { getAll: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  expertRoutingLogDb: { getByConfigId: vi.fn(), getStatistics: vi.fn(), getRouteStats: vi.fn(), getDifficultyStats: vi.fn(), getClassifierLatencies: vi.fn(), getRecentRoutingDecisions: vi.fn(), getClassifierModelStats: vi.fn(), getById: vi.fn() },
  apiRequestDb: { getUsageByRouteLogIds: vi.fn() },
  expertRoutingTrainingRecordDb: { upsertFeedback: vi.fn(), listByConfig: vi.fn() },
  expertRoutingSessionBindingDb: { deleteByConfig: vi.fn(), deleteByExpert: vi.fn() },
  modelDb: { getByExpertRoutingId: vi.fn(), update: vi.fn(), delete: vi.fn(), getById: vi.fn(), getByProviderId: vi.fn(), create: vi.fn(), getAll: vi.fn() },
  virtualKeyDb: { countByModels: vi.fn() },
  invalidateModel: vi.fn(),
  connection: {},
  withTransaction: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  expertRoutingConfigDb: mocks.expertRoutingConfigDb,
  expertRoutingLogDb: mocks.expertRoutingLogDb,
  apiRequestDb: mocks.apiRequestDb,
  expertRoutingTrainingRecordDb: mocks.expertRoutingTrainingRecordDb,
  expertRoutingSessionBindingDb: mocks.expertRoutingSessionBindingDb,
  modelDb: mocks.modelDb,
  virtualKeyDb: mocks.virtualKeyDb,
  withTransaction: mocks.withTransaction,
}));

vi.mock('../services/hot-config-cache.js', () => ({
  hotConfigCache: { invalidateModel: mocks.invalidateModel },
}));

vi.mock('../services/logger.js', () => ({
  memoryLogger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock('../services/expert-router/preprocess/index.js', () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(async (request: any) => ({
      intentText: request.body?.messages?.[0]?.content ?? '',
      stats: { promptTokens: 5, cleanedLength: 12 },
    })),
  },
}));

vi.mock('../services/expert-router/jev-client.js', () => ({
  chooseDifficulty: vi.fn(),
  getJevConfiguration: vi.fn(() => ({ model: 'jev-1.13.0' })),
  getJevBreakerState: vi.fn(() => ({ open: false, openUntil: null, consecutiveFailures: 0, lastError: null })),
}));

vi.mock('../services/expert-router.js', () => ({
  groupByBand: (experts: any[]) => ({
    low: experts.filter((e) => e.band === 'low'),
    medium: experts.filter((e) => e.band === 'medium'),
    high: experts.filter((e) => e.band === 'high'),
  }),
}));

import { expertRoutingRoutes } from './expert-routing.js';
import { chooseDifficulty } from '../services/expert-router/jev-client.js';

const chooseDifficultyMock = vi.mocked(chooseDifficulty);

function createFastifyStub() {
  const routes = new Map<string, Function>();
  // Separate map: `routes.delete` would collide with Map.prototype.delete
  const deleteRoutes = new Map<string, Function>();
  const postRoutes = new Map<string, Function>();
  const putRoutes = new Map<string, Function>();
  return {
    routes,
    deleteRoutes,
    postRoutes,
    putRoutes,
    fastify: {
      authenticate: vi.fn(),
      addHook: vi.fn(),
      get: vi.fn((path: string, handler: Function) => routes.set(path, handler)),
      post: vi.fn((path: string, handler: Function) => postRoutes.set(path, handler)),
      put: vi.fn((path: string, handler: Function) => putRoutes.set(path, handler)),
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
    mocks.withTransaction.mockImplementation(async (operation) => operation(mocks.connection));
    mocks.modelDb.getByExpertRoutingId.mockResolvedValue([]);
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

  it('returns difficulty/band distributions and fail-open rate from persisted stats', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({
      id: 'routing-1',
      config: JSON.stringify({
        experts: [
          { id: 'cheap', band: 'low', type: 'virtual', model_id: 'm-cheap' },
          { id: 'pro', band: 'high', type: 'virtual', model_id: 'm-pro' },
        ],
      }),
    });
    // §5.8 saving: cheap in/out 1e-6/2e-6 (cache 1e-7); high-tier baseline 1e-5/2e-5.
    mocks.modelDb.getById.mockImplementation(async (mid: string) => ({
      id: mid,
      enabled: 1,
      model_attributes: JSON.stringify(
        mid === 'm-cheap'
          ? { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, input_cost_per_token_cache_hit: 0.0000001 }
          : { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 },
      ),
    }));
    mocks.expertRoutingLogDb.getRecentRoutingDecisions.mockResolvedValue([
      { id: 'log-1', selected_expert_id: 'cheap', band: 'low' },
    ]);
    mocks.apiRequestDb.getUsageByRouteLogIds.mockResolvedValue([
      { route_log_id: 'log-1', prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 400 },
    ]);
    mocks.expertRoutingLogDb.getStatistics.mockResolvedValue([
      { count: 10, avg_time: 20 },
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
    mocks.expertRoutingLogDb.getClassifierLatencies.mockResolvedValue(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 200],
    );

    const { routes, fastify } = createFastifyStub();
    await expertRoutingRoutes(fastify);

    const response: any = await routes.get('/:id/statistics')!({
      params: { id: 'routing-1' },
      query: {},
    });

    expect(mocks.expertRoutingLogDb.getDifficultyStats).toHaveBeenCalledWith('routing-1', undefined);
    expect(response.difficultyDistribution).toEqual({ high: 6, unclassified: 4 });
    expect(response.bandDistribution).toEqual({ high: 6, low: 4 });
    expect(response.classifierLatency).toEqual({ count: 10, p50: 50, p95: 200, avg: 65 });
    expect(response.routeSourceDistribution.fail_open).toBe(1);
    expect(response.failOpenRate).toBe(0.3);
    // §5.8: actual = (1000-400)*1e-6 + 400*1e-7 + 200*2e-6 = 0.00104;
    // all-high baseline = 1000*1e-5 + 200*2e-5 = 0.014 → saving 0.01296 (92.57%).
    expect(response.estimatedSavingVsHighBand).toEqual({
      actualCost: 0.00104,
      baselineCost: 0.014,
      saving: 0.01296,
      savingPct: 92.57,
      linkedRequests: 1,
      cacheHitTokens: 400,
    });
    expect(response.limitations.some((item: string) => item.includes('estimatedSavingVsHighBand'))).toBe(false);
  });

  it('returns null fail-open rate and empty distributions when no stats rows exist', async () => {
    mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1', config: JSON.stringify({ experts: [] }) });
    mocks.expertRoutingLogDb.getRecentRoutingDecisions.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getStatistics.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getRouteStats.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getDifficultyStats.mockResolvedValue([]);
    mocks.expertRoutingLogDb.getClassifierLatencies.mockResolvedValue([]);

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
    expect(reply.payload).toMatchObject({
      error: {
        message: expect.stringContaining('仍被虚拟密钥引用'),
        type: 'invalid_request_error',
        param: null,
        code: 'validation_error',
      },
    });
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
  describe('simulate', () => {
    const draftExperts = [
      { id: 'fast', type: 'real', provider_id: 'p', model: 'f', band: 'low' },
      { id: 'deep', type: 'real', provider_id: 'p', model: 'd', band: 'high' },
    ];

    beforeEach(() => {
      chooseDifficultyMock.mockResolvedValue({
        model: 'jev-1.13.0', verdict: 'high', confidence: 0.9,
        ranked: [
          { expertId: 'high', probability: 0.9 },
          { expertId: 'medium', probability: 0.07 },
          { expertId: 'low', probability: 0.03 },
        ],
      });
    });

    it('simulates an unsaved draft config without upstream calls or persistence', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await postRoutes.get('/simulate')!({
        body: {
          prompt: '重构这个模块',
          config: { experts: draftExperts },
        },
      });

      expect(response.difficulty).toBe('high');
      expect(response.band).toBe('high');
      expect(response.wouldHit).toBe('deep');
      expect(response.intentText).toBe('重构这个模块');
      expect(response.candidates.map((c: any) => c.id)).toEqual(['deep']);
      expect(typeof response.classifierTimeMs).toBe('number');
      // No config read, no log writes: simulate is side-effect free.
      expect(mocks.expertRoutingConfigDb.getById).not.toHaveBeenCalled();
      expect(mocks.expertRoutingLogDb.getById).not.toHaveBeenCalled();
    });

    it('simulates a saved config by id', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        config: JSON.stringify({ experts: draftExperts }),
      });
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await postRoutes.get('/:id/simulate')!({
        params: { id: 'routing-1' },
        body: { prompt: '你好' },
      });
      expect(mocks.expertRoutingConfigDb.getById).toHaveBeenCalledWith('routing-1');
      expect(response.difficulty).toBe('high');
    });

    it('surfaces classifier outages as 503', async () => {
      chooseDifficultyMock.mockRejectedValue(new Error('circuit breaker open'));
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const err: any = await postRoutes.get('/simulate')!({
        body: { prompt: 'x', config: { experts: draftExperts } },
      }).catch((e: any) => e);
      expect(err.message).toContain('Jev 分类器不可用');
      expect(err.statusCode).toBe(503);
    });

    it('requires a prompt or messages', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const err: any = await postRoutes.get('/simulate')!({
        body: { config: { experts: draftExperts } },
      }).catch((e: any) => e);
      expect(err.message).toContain('至少提供一个');
    });
  });

  describe('§5.9 feedback', () => {
    it('upserts a corrected-tier training record from a routing log', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
      mocks.expertRoutingLogDb.getById.mockResolvedValue({
        id: 'log-1',
        expert_routing_id: 'routing-1',
        request_hash: 'hash-1',
        difficulty: 'low',
        band: 'low',
        selected_expert_id: 'fast',
        intent_text: '你好',
        classifier_response: JSON.stringify({ verdictConfidence: 0.8 }),
      });
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response = await postRoutes.get('/:id/logs/:logId/feedback')!({
        params: { id: 'routing-1', logId: 'log-1' },
        body: { rating: 'too_low' },
      });

      expect(response).toEqual({ success: true, corrected: 'medium' });
      expect(mocks.expertRoutingTrainingRecordDb.upsertFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          expert_routing_id: 'routing-1',
          input_hash: 'hash-1',
          input_text: '你好',
          judge_intent_label: 'low',
          judge_confidence: 0.8,
          final_intent_label: 'medium',
          final_expert_id: 'fast',
        }),
      );
    });

    it('too_high on high corrects down to medium', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({ id: 'routing-1' });
      mocks.expertRoutingLogDb.getById.mockResolvedValue({
        id: 'log-2',
        expert_routing_id: 'routing-1',
        request_hash: 'hash-2',
        difficulty: 'high',
        band: 'high',
        selected_expert_id: 'review',
        classifier_response: '{}',
      });
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response = await postRoutes.get('/:id/logs/:logId/feedback')!({
        params: { id: 'routing-1', logId: 'log-2' },
        body: { rating: 'too_high' },
      });
      expect(response.corrected).toBe('medium');
    });
  });

  describe('bands preview', () => {
    const storedExperts = [
      { id: 'cheap', type: 'real', provider_id: 'prov-1', model: 'cheap-model' },
      { id: 'pricey', type: 'real', provider_id: 'prov-1', model: 'pricey-model' },
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
            { id: 'draft-high', type: 'real', provider_id: 'prov-1', model: 'pricey-model', band: 'high' },
            { id: 'draft-cheap', type: 'real', provider_id: 'prov-1', model: 'cheap-model' },
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

  describe('draft create/update contract (空草稿)', () => {
    const validExperts = [
      { id: 'vm-1', type: 'virtual', model_id: 'vm-1', band: 'low' },
    ];

    beforeEach(() => {
      mocks.expertRoutingConfigDb.create.mockImplementation(async (data: any) => ({
        ...data,
        created_at: 1,
        updated_at: 1,
      }));
      mocks.modelDb.create.mockImplementation(async (data: any) => ({ ...data }));
      mocks.modelDb.getById.mockResolvedValue({ id: 'vm-1', name: 'VM', enabled: 1 });
    });

    it('creates an empty-experts draft as disabled even when enabled is requested', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await postRoutes.get('/')!({
        body: { name: '草稿', enabled: true, experts: [] },
      });

      expect(response.enabled).toBe(false);
      expect(mocks.expertRoutingConfigDb.create.mock.calls[0][0]).toMatchObject({
        name: '草稿',
        enabled: 0,
      });
      // The expert virtual model is still created so the draft is reachable.
      expect(mocks.modelDb.create).toHaveBeenCalledTimes(1);
    });

    it('creates an enabled config when experts are present', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await postRoutes.get('/')!({
        body: { name: '正式', experts: validExperts },
      });

      expect(response.enabled).toBe(true);
      expect(mocks.expertRoutingConfigDb.create.mock.calls[0][0].enabled).toBe(1);
    });

    it('returns 400 (not 500) for validation failures', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);
      const reply = createReplyStub();

      await postRoutes.get('/')!(
        { body: { name: 'x', experts: [{ id: 'vm-1', type: 'virtual', model_id: 'vm-1' }] } },
        reply,
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: {
          message: expect.stringContaining('band'),
          type: 'invalid_request_error',
          param: null,
          code: 'validation_error',
        },
      });
      expect(mocks.expertRoutingConfigDb.create).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed bodies instead of 500', async () => {
      const { postRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);
      const reply = createReplyStub();

      await postRoutes.get('/')!({ body: { experts: [] } }, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: {
          message: expect.stringContaining('请求参数验证失败'),
          type: 'invalid_request_error',
          param: null,
          code: 'validation_error',
        },
      });
    });

    it('refuses to enable an empty draft with 400', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '草稿',
        enabled: 0,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);
      const reply = createReplyStub();

      await putRoutes.get('/:id')!({ params: { id: 'routing-1' }, body: { enabled: true } }, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.payload).toMatchObject({
        error: {
          message: expect.stringContaining('启用前至少需要配置一个候选模型'),
          type: 'invalid_request_error',
          param: null,
          code: 'validation_error',
        },
      });
      expect(mocks.expertRoutingConfigDb.update).not.toHaveBeenCalled();
    });

    it('still allows disabling or saving an empty draft', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '草稿',
        enabled: 0,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await putRoutes.get('/:id')!({
        params: { id: 'routing-1' },
        body: { enabled: false },
      });

      expect(response.id).toBe('routing-1');
      expect(mocks.expertRoutingConfigDb.update).toHaveBeenCalledWith(
        'routing-1',
        expect.objectContaining({ enabled: 0 }),
        mocks.connection,
      );
    });
  });

  describe('exposed model name (对外模型名)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('GET list and detail return the exposed virtual model', async () => {
      mocks.expertRoutingConfigDb.getAll.mockResolvedValue([
        { id: 'routing-1', name: '配置', enabled: 1, config: JSON.stringify({ version: 2, experts: [] }) },
      ]);
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '配置',
        enabled: 1,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      mocks.modelDb.getByExpertRoutingId.mockResolvedValue([
        { id: 'model-1', name: 'my-router', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
      ]);
      const { routes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const list: any = await routes.get('/')!({});
      expect(list.configs[0].virtualModel).toMatchObject({ id: 'model-1', name: 'my-router', isVirtual: true });

      const detail: any = await routes.get('/:id')!({ params: { id: 'routing-1' } });
      expect(detail.virtualModel).toMatchObject({ id: 'model-1', name: 'my-router' });
    });

    it('PUT with virtualModelName renames the exposed model and returns it', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '配置',
        enabled: 1,
        config: JSON.stringify({ version: 2, experts: [{ id: 'e1', band: 'low', type: 'virtual', model_id: 'm1' }] }),
      });
      mocks.modelDb.getByExpertRoutingId
        .mockResolvedValueOnce([
          { id: 'model-1', name: '旧名字', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
        ])
        .mockResolvedValue([
          { id: 'model-1', name: 'my-router', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
        ]);
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await putRoutes.get('/:id')!({
        params: { id: 'routing-1' },
        body: { virtualModelName: 'my-router' },
      });

      expect(mocks.modelDb.update).toHaveBeenCalledWith('model-1', { name: 'my-router' }, mocks.connection);
      expect(mocks.invalidateModel).toHaveBeenCalledWith('model-1');
      expect(response.virtualModel).toMatchObject({ id: 'model-1', name: 'my-router' });
    });

    it('PUT with virtualModelName creates the exposed model when absent', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '配置',
        enabled: 0,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      mocks.modelDb.getByExpertRoutingId.mockResolvedValue([]);
      mocks.modelDb.create.mockResolvedValue({
        id: 'model-new',
        name: 'my-router',
        provider_id: null,
        model_identifier: 'expert-routing-1',
        is_virtual: 1,
        expert_routing_id: 'routing-1',
      });
      // 创建后重查返回新行：模拟真实 DB 读到新建后的暴露模型。
      mocks.modelDb.getByExpertRoutingId
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          { id: 'model-new', name: 'my-router', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
        ]);
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      const response: any = await putRoutes.get('/:id')!({
        params: { id: 'routing-1' },
        body: { virtualModelName: 'my-router' },
      });

      expect(mocks.modelDb.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my-router', model_identifier: 'expert-routing-1', expert_routing_id: 'routing-1', is_virtual: 1 }),
        mocks.connection,
      );
      expect(mocks.invalidateModel).toHaveBeenCalledWith('model-new');
      expect(response.virtualModel).toMatchObject({ id: 'model-new', name: 'my-router' });
    });

    it('PUT without virtualModelName keeps the config-name sync behavior', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1',
        name: '旧配置名',
        enabled: 1,
        config: JSON.stringify({ version: 2, experts: [{ id: 'e1', band: 'low', type: 'virtual', model_id: 'm1' }] }),
      });
      mocks.modelDb.getAll.mockResolvedValue([
        { id: 'model-1', name: '旧配置名', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
      ]);
      mocks.modelDb.getByExpertRoutingId.mockResolvedValue([
        { id: 'model-1', name: '新配置名', provider_id: null, model_identifier: 'expert-routing-1', is_virtual: 1, expert_routing_id: 'routing-1' },
      ]);
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      await putRoutes.get('/:id')!({
        params: { id: 'routing-1' },
        body: { name: '新配置名' },
      });

      expect(mocks.modelDb.update).toHaveBeenCalledWith('model-1', { name: '新配置名' }, mocks.connection);
    });

    it.each(['create', 'rename'])('keeps %s failures inside the transaction without invalidating caches', async (operation) => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1', name: 'old-config', enabled: 0,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      mocks.modelDb.getByExpertRoutingId.mockResolvedValue(operation === 'create' ? [] : [{
        id: 'model-1', name: 'old-model', is_virtual: 1, model_identifier: 'expert-routing-1',
      }]);
      const modelWrite = operation === 'create' ? mocks.modelDb.create : mocks.modelDb.update;
      const error = new Error('model write failed');
      modelWrite.mockRejectedValueOnce(error);
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      await expect(putRoutes.get('/:id')!({
        params: { id: 'routing-1' },
        body: { name: 'new-config', virtualModelName: 'new-model' },
      })).rejects.toBe(error);

      expect(mocks.withTransaction).toHaveBeenCalledOnce();
      expect(mocks.expertRoutingConfigDb.update).toHaveBeenCalledWith(
        'routing-1', expect.objectContaining({ name: 'new-config' }), mocks.connection,
      );
      expect(modelWrite.mock.calls[0].at(-1)).toBe(mocks.connection);
      expect(mocks.invalidateModel).not.toHaveBeenCalled();
    });

    it('does not invalidate model caches before the transaction commits', async () => {
      mocks.expertRoutingConfigDb.getById.mockResolvedValue({
        id: 'routing-1', name: 'old-config', enabled: 0,
        config: JSON.stringify({ version: 2, experts: [] }),
      });
      mocks.modelDb.getByExpertRoutingId.mockResolvedValue([{ 
        id: 'model-1', name: 'old-model', is_virtual: 1, model_identifier: 'expert-routing-1',
      }]);
      const error = new Error('commit failed');
      mocks.withTransaction.mockImplementationOnce(async (operation) => {
        await operation(mocks.connection);
        expect(mocks.invalidateModel).not.toHaveBeenCalled();
        throw error;
      });
      const { putRoutes, fastify } = createFastifyStub();
      await expertRoutingRoutes(fastify);

      await expect(putRoutes.get('/:id')!({
        params: { id: 'routing-1' }, body: { virtualModelName: 'new-model' },
      })).rejects.toBe(error);
      expect(mocks.modelDb.update).toHaveBeenCalledWith('model-1', { name: 'new-model' }, mocks.connection);
      expect(mocks.invalidateModel).not.toHaveBeenCalled();
    });
  });
});
