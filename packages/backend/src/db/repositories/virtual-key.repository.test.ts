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
      context_budget_tokens: null,
      image_compression_enabled: 0,
      intercept_zero_temperature: 0,
      zero_temperature_replacement: null,
      pii_protection_enabled: 0,
    } as any);

    const [sql, values] = mocks.connection.query.mock.calls[0];
    expect((sql.match(/\?/g) || [])).toHaveLength(values.length);
  });
});

describe('virtualKeyRepository.rotate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  it('updates key_value, key_hash and updated_at in one statement', async () => {
    await virtualKeyRepository.rotate('vk-1', 'sk-rotated', 'hash-rotated');

    const [, values] = mocks.connection.query.mock.calls[0];
    expect(values).toEqual(['sk-rotated', 'hash-rotated', expect.any(Number), 'vk-1']);
  });
});

describe('virtualKeyRepository.countByModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([
      [
        { id: 'vk-a', model_id: 'model-1', model_ids: null, routing_config: null },
        { id: 'vk-b', model_id: null, model_ids: JSON.stringify(['model-1', 'model-1']), routing_config: null },
        { id: 'vk-c', model_id: null, model_ids: null, routing_config: JSON.stringify({ targets: [{ provider: 'prov', override_params: { model: 'gpt-x' } }] }) },
      ],
    ]);
  });

  it('counts direct, multi-binding and routing-config references with dedupe', async () => {
    const counts = await virtualKeyRepository.countByModels([
      { id: 'model-1', provider_id: 'prov', model_identifier: 'gpt-x', name: 'GPT X' },
      { id: 'model-2', provider_id: 'prov', model_identifier: 'gpt-y', name: 'GPT Y' },
    ]);

    expect(counts.get('model-1')).toBe(3);
    expect(counts.get('model-2')).toBe(0);
    expect(mocks.connection.query).toHaveBeenCalledWith(
      `SELECT id, model_id, model_ids, routing_config FROM virtual_keys`
    );
  });

  it('no longer exposes the legacy id-only counters', () => {
    expect((virtualKeyRepository as any).countByModelId).toBeUndefined();
    expect((virtualKeyRepository as any).countByModelIds).toBeUndefined();
  });
});
