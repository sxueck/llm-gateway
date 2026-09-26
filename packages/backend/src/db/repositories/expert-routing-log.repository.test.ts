import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    connection,
    getConnection: vi.fn(async () => connection),
  };
});

vi.mock('../connection.js', () => ({
  getDatabase: () => ({ getConnection: mocks.getConnection }),
}));

import { expertRoutingLogRepository } from './expert-routing-log.repository.js';

describe('expertRoutingLogRepository projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  it('includes classifier_request in getByConfigId so legacy route inference works', async () => {
    await expertRoutingLogRepository.getByConfigId('routing-1', 25);

    const [sql] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/\bclassifier_request\b/);
    expect(sql).toMatch(/\broute_source\b/);
  });

  it('includes classifier_request in getByCategory so legacy route inference works', async () => {
    await expertRoutingLogRepository.getByCategory('routing-1', 'code_authoring', 10);

    const [sql] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/\bclassifier_request\b/);
    expect(sql).toMatch(/\broute_source\b/);
  });
});
describe('expertRoutingLogRepository v47 difficulty/classifier columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  it('create() inserts difficulty, band, verdict_reused, classifier_time_ms', async () => {
    await expertRoutingLogRepository.create({
      id: 'log-1',
      virtual_key_id: null,
      expert_routing_id: 'routing-1',
      request_hash: 'hash',
      classifier_model: 'm',
      classification_result: 'code_authoring',
      selected_expert_id: 'e1',
      selected_expert_type: 'local_onnx',
      selected_expert_name: 'E1',
      classification_time: 5,
      difficulty: 'hard',
      band: 'high',
      verdict_reused: true,
      classifier_time_ms: 42,
    });

    const [sql, params] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/\bdifficulty\b/);
    expect(sql).toMatch(/\bband\b/);
    expect(sql).toMatch(/\bverdict_reused\b/);
    expect(sql).toMatch(/\bclassifier_time_ms\b/);
    expect(params).toContain('hard');
    expect(params).toContain('high');
    expect(params).toContain(1);
    expect(params).toContain(42);
  });

  it('create() maps falsy difficulty/verdict_reused to NULL/0', async () => {
    await expertRoutingLogRepository.create({
      id: 'log-2',
      virtual_key_id: null,
      expert_routing_id: 'routing-1',
      request_hash: 'hash',
      classifier_model: 'm',
      classification_result: 'x',
      selected_expert_id: 'e1',
      selected_expert_type: 'local_onnx',
      selected_expert_name: 'E1',
      classification_time: 5,
    });

    const [, params] = mocks.connection.query.mock.calls[0];
    expect(params).toContain(0);
    expect(params.filter((p: any) => p === null).length).toBeGreaterThanOrEqual(2);
  });

  it('getByConfigId and getByCategory select the v47 columns', async () => {
    await expertRoutingLogRepository.getByConfigId('routing-1');
    let [sql] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/\bdifficulty\b/);
    expect(sql).toMatch(/\bverdict_reused\b/);
    expect(sql).toMatch(/\bclassifier_time_ms\b/);

    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
    await expertRoutingLogRepository.getByCategory('routing-1', 'x');
    [sql] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/\bdifficulty\b/);
  });

  it('getDifficultyStats groups by difficulty, band and aggregates reuse/latency', async () => {
    mocks.connection.query.mockResolvedValueOnce([[{ difficulty: 'hard', count: 3 }]]);
    const rows = await expertRoutingLogRepository.getDifficultyStats('routing-1', 60000);
    const [sql, params] = mocks.connection.query.mock.calls[0];
    expect(sql).toMatch(/GROUP BY difficulty, band/);
    expect(sql).toMatch(/SUM\(verdict_reused\)/);
    expect(sql).toMatch(/AVG\(classifier_time_ms\)/);
    expect(params[0]).toBe('routing-1');
    expect(rows).toEqual([{ difficulty: 'hard', count: 3 }]);
  });

  it('getDifficultyStats returns [] on pre-v47 schemas (missing column)', async () => {
    const err: any = new Error("Unknown column 'difficulty' in 'field list'");
    err.code = 'ER_BAD_FIELD_ERROR';
    mocks.connection.query.mockRejectedValueOnce(err);
    const rows = await expertRoutingLogRepository.getDifficultyStats('routing-1');
    expect(rows).toEqual([]);
  });
});
