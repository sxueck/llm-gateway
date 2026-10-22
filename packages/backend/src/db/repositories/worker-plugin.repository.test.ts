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

import { workerPluginRepository } from './worker-plugin.repository.js';

describe('workerPluginRepository.getLatestRunnableByPluginId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  it('selects the newest non-draft, non-revoked row for the plugin id', async () => {
    mocks.connection.query.mockResolvedValue([
      [{ id: 'com.llm-gateway.code-search', version: '1.0.6' }],
    ]);
    const row = await workerPluginRepository.getLatestRunnableByPluginId(
      'com.llm-gateway.code-search',
    );

    const [, values] = mocks.connection.query.mock.calls[0];
    expect(values).toEqual(['com.llm-gateway.code-search']);
    expect(row?.version).toBe('1.0.6');
  });

  it('returns undefined when no row matches', async () => {
    const row = await workerPluginRepository.getLatestRunnableByPluginId(
      'com.llm-gateway.code-search',
    );
    expect(row).toBeUndefined();
  });
});
