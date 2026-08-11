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

import { virtualKeyRepository } from './virtual-key.repository.js';

describe('virtualKeyRepository.create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  it('binds one value for every INSERT column', async () => {
    await virtualKeyRepository.create({
      id: 'vk-1',
      key_value: 'sk-test',
      key_hash: 'hash',
      name: 'Test key',
      provider_id: null,
      model_id: null,
      routing_strategy: 'single',
      model_ids: null,
      routing_config: null,
      enabled: 1,
      rate_limit: 0,
      cache_enabled: 0,
      disable_logging: 0,
      dynamic_compression_enabled: 0,
      image_compression_enabled: 0,
      intercept_zero_temperature: 0,
      zero_temperature_replacement: null,
      pii_protection_enabled: 0,
      prompt_capture_enabled: 0,
    } as any);

    const [sql, values] = mocks.connection.query.mock.calls[0];
    expect((sql.match(/\?/g) || [])).toHaveLength(values.length);
  });
});
