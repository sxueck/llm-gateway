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