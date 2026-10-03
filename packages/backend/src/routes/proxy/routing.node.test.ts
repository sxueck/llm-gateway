import { expect, test, vi } from 'vitest';
import { resolveProviderFromModel } from './routing.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';

const mocks = vi.hoisted(() => ({ config: vi.fn(), provider: vi.fn() }));
vi.mock('../../db/index.js', () => ({
  routingConfigDb: { getById: mocks.config }, modelDb: { getByProviderId: vi.fn(async () => []) },
  virtualKeyDb: { getById: vi.fn(async () => undefined) }, expertRoutingConfigDb: {},
}));
vi.mock('../../services/hot-config-cache.js', () => ({ hotConfigCache: { getProviderById: mocks.provider } }));
vi.mock('../../services/expert-router.js', () => ({ expertRouter: {} }));

test('resolved virtual target retains retry eligibility for owner-side fallback', async () => {
  circuitBreaker.resetAll();
  mocks.provider.mockImplementation(async (id: string) => ({ id, enabled: 1 }));
  mocks.config.mockResolvedValue({ type: 'fallback', config: JSON.stringify({ strategy: { mode: 'fallback' }, targets: [{ provider: 'provider-a' }, { provider: 'provider-b' }] }) });
  const request: any = { protocol: 'openai', body: { model: 'virtual-model' }, headers: {} };
  const result = await resolveProviderFromModel({ id: 'virtual-model', is_virtual: 1, routing_config_id: 'node-fallback-config' }, request);
  expect(result.providerId).toBe('provider-a');
  expect(result.canRetry).toBe(true);
  expect(result.excludeTargetKeys).toEqual(new Set(['provider-a']));
});
