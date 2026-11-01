import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  getByKeyValue: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  delete: vi.fn(),
  deleteBindingsByScope: vi.fn(),
  withTransaction: vi.fn(),
  modelGetById: vi.fn(),
  providerGetById: vi.fn(),
  invalidateVirtualKey: vi.fn(),
  hashKey: vi.fn(() => 'hashed'),
  maskKey: vi.fn((key: string) => (key.length <= 8 ? '***' : `***${key.slice(-4)}`)),
  txConnection: { __testTransactionConnection: true },
  // 配额两表（virtual_key_model_quotas / virtual_key_model_daily_usage）：路由模块
  // 的导入链（services/virtual-key-quota.js）会解构它们，mock 里必须有这个键。
  quotaGetAll: vi.fn(),
  quotaGetByVirtualKeyId: vi.fn(),
  quotaApplyBulk: vi.fn(),
  usageGetDayUsage: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  virtualKeyDb: {
    getAll: mocks.getAll,
    getById: mocks.getById,
    getByKeyValue: mocks.getByKeyValue,
    create: mocks.create,
    update: mocks.update,
    rotate: mocks.rotate,
    delete: mocks.delete,
  },
  modelDb: { getById: mocks.modelGetById },
  providerDb: { getById: mocks.providerGetById },
  contextNormalizationDb: { deleteBindingsByScope: mocks.deleteBindingsByScope },
  virtualKeyModelQuotaDb: {
    getAll: mocks.quotaGetAll,
    getByVirtualKeyId: mocks.quotaGetByVirtualKeyId,
    applyBulk: mocks.quotaApplyBulk,
  },
  virtualKeyModelUsageDb: { getDayUsage: mocks.usageGetDayUsage },
  withTransaction: mocks.withTransaction,
}));

vi.mock('../services/hot-config-cache.js', () => ({
  hotConfigCache: { invalidateVirtualKey: mocks.invalidateVirtualKey },
}));

// Keeps the config module (JWT_SECRET) out of the test process.
vi.mock('../utils/crypto.js', () => ({ hashKey: mocks.hashKey, maskKey: mocks.maskKey }));

import { virtualKeyRoutes } from './virtual-keys.js';
import type { VirtualKey } from '../types/index.js';

function makeVirtualKey(overrides: Partial<VirtualKey> = {}): VirtualKey {
  return {
    id: 'vk_1',
    key_value: 'sk-vk-1',
    key_hash: 'hashed',
    name: 'key',
    provider_id: null,
    model_id: null,
    routing_strategy: 'single',
    model_ids: null,
    routing_config: null,
    enabled: 1,
    rate_limit: null,
    cache_enabled: 0,
    disable_logging: 0,
    context_budget_tokens: null,
    image_compression_enabled: 0,
    intercept_zero_temperature: 0,
    zero_temperature_replacement: null,
    pii_protection_enabled: 0,
    context_normalization_enabled: 0,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorate('authenticate', async () => {});
  await virtualKeyRoutes(app);
  return app;
}

function createPayload(overrides: Record<string, unknown> = {}) {
  return { name: 'key', keyType: 'auto', ...overrides };
}

describe('virtual key routing strategy contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async (vk: VirtualKey) => ({ ...vk }));
  });

  it.each(['load-balance', 'failover', 'cheapest', ''])(
    'create rejects the unsupported strategy %j without persisting',
    async (routingStrategy) => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/',
        payload: createPayload({ routingStrategy }),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({
        type: 'invalid_request_error',
        code: 'validation_error',
        param: 'routingStrategy',
      });
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it.each(['single', 'default', 'price', 'throughput', 'latency'])(
    'create accepts the runtime strategy %j and persists it verbatim',
    async (routingStrategy) => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/',
        payload: createPayload({ routingStrategy }),
      });

      expect(res.statusCode).toBe(200);
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ routing_strategy: routingStrategy })
      );
      expect(res.json().virtualKey.routingStrategy).toBe(routingStrategy);
    }
  );

  it('update rejects an unsupported strategy and accepts a runtime one', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey());

    const rejected = await app.inject({
      method: 'PUT',
      url: '/vk_1',
      payload: { routingStrategy: 'load-balance' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.getById.mockResolvedValueOnce(makeVirtualKey()).mockResolvedValueOnce(
      makeVirtualKey({ routing_strategy: 'price' })
    );
    const accepted = await app.inject({
      method: 'PUT',
      url: '/vk_1',
      payload: { routingStrategy: 'price' },
    });

    expect(accepted.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { routing_strategy: 'price' });
    expect(accepted.json().routingStrategy).toBe('price');
  });
});

describe('virtual key zero temperature replacement fidelity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async (vk: VirtualKey) => ({ ...vk }));
  });

  it('create persists and returns a valid replacement of 0 instead of null', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: createPayload({ interceptZeroTemperature: true, zeroTemperatureReplacement: 0 }),
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ zero_temperature_replacement: 0 })
    );
    expect(res.json().virtualKey.zeroTemperatureReplacement).toBe(0);
  });

  it.each([
    ['numeric 0 from the driver', 0],
    ['decimal string from the driver', '0.00'],
  ])('update response keeps a stored replacement of %s', async (_label, stored) => {
    const app = await buildApp();
    mocks.getById
      .mockResolvedValueOnce(makeVirtualKey())
      .mockResolvedValueOnce(makeVirtualKey({ zero_temperature_replacement: stored as any }));

    const res = await app.inject({
      method: 'PUT',
      url: '/vk_1',
      payload: { interceptZeroTemperature: true, zeroTemperatureReplacement: 0 },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', {
      intercept_zero_temperature: 1,
      zero_temperature_replacement: 0,
    });
    expect(res.json().zeroTemperatureReplacement).toBe(0);
  });

  it('serializes an unset replacement as null', async () => {
    const app = await buildApp();
    mocks.getAll.mockResolvedValue([
      makeVirtualKey({ zero_temperature_replacement: 0 }),
      makeVirtualKey(),
    ]);

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.json().virtualKeys.map((vk: any) => vk.zeroTemperatureReplacement)).toEqual([0, null]);
  });
});

// `null` is the explicit-clear signal (the same contract contextBudgetTokens already
// used): omitting a field leaves it alone, sending null unsets it.
describe('virtual key explicit-clear contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue(undefined);
    mocks.create.mockImplementation(async (vk: VirtualKey) => ({ ...vk }));
  });

  it('update clears an emptied rate limit instead of rejecting it', async () => {
    const app = await buildApp();
    mocks.getById
      .mockResolvedValueOnce(makeVirtualKey({ rate_limit: 60 }))
      .mockResolvedValueOnce(makeVirtualKey({ rate_limit: null }));

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { rateLimit: null } });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { rate_limit: null });
    expect(res.json().rateLimit).toBeNull();
  });

  it('update clears an emptied temperature replacement', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(
      makeVirtualKey({ intercept_zero_temperature: 1, zero_temperature_replacement: '0.70' as any })
    );

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { zeroTemperatureReplacement: null } });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { zero_temperature_replacement: null });
  });

  it('create accepts a null rate limit and stores it as unlimited', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: createPayload({ rateLimit: null }),
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ rate_limit: null }));
  });

  it('re-binding models drops the legacy model_id pin that outranks model_ids at runtime', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy', model_ids: '["m_legacy"]' }));
    mocks.modelGetById.mockResolvedValue({ id: 'm_b', name: 'B', model_identifier: 'b' } as any);

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { modelIds: ['m_b'] } });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', {
      model_ids: JSON.stringify(['m_b']),
      model_id: null,
    });
  });

  it('keeps an untouched model_id pin when the re-bound list still contains it', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy', model_ids: '["m_legacy"]' }));
    mocks.modelGetById.mockResolvedValue({ id: 'm_legacy', name: 'Legacy', model_identifier: 'legacy' } as any);

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { modelIds: ['m_legacy'] } });

    expect(res.statusCode).toBe(200);
    // Exact-object match: a cleared pin here would silently turn the key's runtime
    // override into name matching (model-resolver) and break existing clients.
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { model_ids: JSON.stringify(['m_legacy']) });
  });

  it('keeps an explicitly supplied model_id over the auto-clear', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy' }));
    mocks.modelGetById
      .mockResolvedValueOnce({ id: 'm_pin', name: 'Pin', model_identifier: 'pin' } as any)
      .mockResolvedValueOnce({ id: 'm_b', name: 'B', model_identifier: 'b' } as any)
      .mockResolvedValue({ id: 'm_b', name: 'B', model_identifier: 'b' } as any);

    const res = await app.inject({
      method: 'PUT',
      url: '/vk_1',
      payload: { modelIds: ['m_b'], modelId: 'm_pin' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', {
      model_id: 'm_pin',
      model_ids: JSON.stringify(['m_b']),
    });
  });

  it('update clears the legacy pin on its own without looking the model up', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy' }));

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { modelId: null } });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { model_id: null });
    expect(mocks.modelGetById).not.toHaveBeenCalled();
  });

  it('a status-only toggle never touches the binding columns', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy' }));

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { enabled: false } });

    expect(res.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('vk_1', { enabled: 0 });
  });

  it('rejects an empty model binding list without persisting', async () => {
    const app = await buildApp();
    mocks.getById.mockResolvedValue(makeVirtualKey({ model_id: 'm_legacy' }));

    const res = await app.inject({ method: 'PUT', url: '/vk_1', payload: { modelIds: [] } });

    expect(res.statusCode).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('virtual key plaintext exposure surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAll.mockResolvedValue([makeVirtualKey({ key_value: 'vk_plain_secret_value_1234' })]);
    mocks.getById.mockResolvedValue(makeVirtualKey({ key_value: 'vk_plain_secret_value_1234' }));
    mocks.create.mockImplementation(async (vk: VirtualKey) => ({ ...vk }));
  });

  it('returns the stored keyValue in the authenticated list response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.json().virtualKeys[0].keyValue).toBe('vk_plain_secret_value_1234');
  });

  it('returns the stored keyValue in the authenticated detail response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/vk_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().keyValue).toBe('vk_plain_secret_value_1234');
  });

  it('create returns the plaintext separately and masks it inside virtualKey', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: createPayload(),
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.keyValue).toMatch(/^vk_/);
    expect(json.virtualKey.keyValue).toBe(`***${json.keyValue.slice(-4)}`);
  });
});

describe('virtual key duplicate-key races', () => {
  const duplicateEntry = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue(makeVirtualKey());
    mocks.getByKeyValue.mockResolvedValue(undefined);
  });

  it('create maps a UNIQUE race to 400 instead of a raw 500', async () => {
    mocks.create.mockRejectedValueOnce(duplicateEntry());
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/',
      payload: createPayload({ keyType: 'custom', customKey: 'sk-raced-key-value' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('密钥值已存在');
  });

  it('rotate maps a UNIQUE race to 400 instead of a raw 500', async () => {
    mocks.rotate.mockRejectedValueOnce(duplicateEntry());
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/vk_1/rotate',
      payload: { keyType: 'custom', customKey: 'sk-raced-key-value' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('密钥值已存在');
  });

  it('other database failures still propagate as 500', async () => {
    mocks.rotate.mockRejectedValueOnce(new Error('connection lost'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/vk_1/rotate',
      payload: { keyType: 'auto' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ type: 'internal_error' });
  });
});

describe('virtual key deletion transactionality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue(makeVirtualKey());
    mocks.withTransaction.mockImplementation(async (operation: any) => operation(mocks.txConnection));
  });

  it('deletes the key and its session bindings on one connection', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/vk_1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith('vk_1', mocks.txConnection);
    expect(mocks.deleteBindingsByScope).toHaveBeenCalledWith('vk_1', mocks.txConnection);
    // 配额行不在这里手工清理：virtual_key_model_quotas / …_daily_usage 对
    // virtual_keys 的 FK ON DELETE CASCADE 负责回收，事务只保证两表同生共死。
    expect(mocks.quotaApplyBulk).not.toHaveBeenCalled();
    expect(mocks.quotaGetByVirtualKeyId).not.toHaveBeenCalled();
    // Cache invalidation happens after the commit, not inside the transaction.
    expect(mocks.invalidateVirtualKey).toHaveBeenCalledWith('sk-vk-1');
  });

  it('propagates transaction failure as 500 without partial writes', async () => {
    mocks.withTransaction.mockRejectedValueOnce(new Error('rollback'));
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: '/vk_1' });

    expect(res.statusCode).toBe(500);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.deleteBindingsByScope).not.toHaveBeenCalled();
  });
});
