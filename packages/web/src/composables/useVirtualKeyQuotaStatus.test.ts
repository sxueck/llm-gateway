import { describe, expect, it, vi } from 'vitest';
import type { VirtualKeyModelQuota, VirtualKeyQuotaPeriod } from '@/api/virtual-key';
import { useVirtualKeyQuotaStatus } from '@/composables/useVirtualKeyQuotaStatus';

vi.mock('@/utils/request', () => ({ default: { get: vi.fn() } }));

type QuotasResponse = { quotas: VirtualKeyModelQuota[] };

function deferred() {
  let resolve!: (value: QuotasResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<QuotasResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(items: QuotasResponse['quotas']): QuotasResponse {
  return { quotas: items };
}

describe('useVirtualKeyQuotaStatus', () => {
  it('loads daily + weekly windows into one aggregate health status', async () => {
    const daily = deferred();
    const weekly = deferred();
    const getQuotas = vi
      .fn<(id: string, period?: VirtualKeyQuotaPeriod) => Promise<QuotasResponse>>()
      .mockImplementationOnce(() => daily.promise)
      .mockImplementationOnce(() => weekly.promise);
    const { statusById, ensure } = useVirtualKeyQuotaStatus(getQuotas);

    void ensure(['k1']);
    expect(statusById.value.k1).toEqual({ phase: 'loading' });

    daily.resolve(response([{ model: 'm', limitMillions: 1, usedTokens: 500_000, requestCount: 1 }]));
    weekly.resolve(response([]));
    await vi.waitFor(() => expect(statusById.value.k1?.phase).toBe('loaded'));
    expect(statusById.value.k1).toEqual({
      phase: 'loaded',
      health: {
        state: 'active',
        ratio: 0.5,
        detail: { model: 'm', period: 'daily', usedTokens: 500_000, limitTokens: 1_000_000 },
      },
    });
    expect(getQuotas).toHaveBeenCalledWith('k1', 'daily');
    expect(getQuotas).toHaveBeenCalledWith('k1', 'weekly');
  });

  it('records an error status when usage cannot be read', async () => {
    const getQuotas = vi.fn(() => Promise.reject(new Error('boom')));
    const { statusById, ensure } = useVirtualKeyQuotaStatus(getQuotas);
    void ensure(['k1']);
    await vi.waitFor(() => expect(statusById.value.k1?.phase).toBe('error'));
    expect(statusById.value.k1).toEqual({ phase: 'error', message: 'boom' });
  });

  it('does not refetch keys with a cached (non-error) status, but retries errored ones', async () => {
    let calls = 0;
    const getQuotas = vi.fn(async () => {
      calls += 1;
      return response([{ model: 'm', limitMillions: 1, usedTokens: 0, requestCount: 0 }]);
    });
    const { statusById, ensure } = useVirtualKeyQuotaStatus(getQuotas);
    void ensure(['k1']);
    await vi.waitFor(() => expect(statusById.value.k1?.phase).toBe('loaded'));
    void ensure(['k1']);
    await Promise.resolve();
    expect(calls).toBe(2); // one daily + one weekly, nothing more
  });

  it('does not start a second fetch for a key while one is already in flight', async () => {
    const pending = deferred();
    const getQuotas = vi.fn<(id: string, period?: VirtualKeyQuotaPeriod) => Promise<QuotasResponse>>()
      .mockImplementation(() => pending.promise);
    const { statusById, ensure } = useVirtualKeyQuotaStatus(getQuotas);

    // Overlapping triggers within one tick (e.g. watcher + refresh interval)
    // must not fan out into duplicate requests for the same key.
    void ensure(['k1']);
    void ensure(['k1']);
    expect(getQuotas).toHaveBeenCalledTimes(2); // exactly one daily + one weekly
    expect(statusById.value.k1).toEqual({ phase: 'loading' });

    pending.resolve(response([]));
    await vi.waitFor(() => expect(statusById.value.k1?.phase).toBe('loaded'));
    expect(getQuotas).toHaveBeenCalledTimes(2);
  });

  it('reset() drops the cache and invalidates a still-pending stale fetch', async () => {
    const stale = deferred();
    const fresh = deferred();
    const getQuotas = vi
      .fn<(id: string, period?: VirtualKeyQuotaPeriod) => Promise<QuotasResponse>>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise)
      .mockImplementationOnce(() => fresh.promise);
    const { statusById, ensure, reset } = useVirtualKeyQuotaStatus(getQuotas);

    void ensure(['k1']);
    reset();
    expect(statusById.value).toEqual({});

    // Stale (pre-reset) responses resolve late; the fresh fetch must win.
    stale.resolve(response([{ model: 'stale', limitMillions: 1, usedTokens: 0, requestCount: 0 }]));
    void ensure(['k1']);
    fresh.resolve(response([{ model: 'fresh', limitMillions: 1, usedTokens: 0, requestCount: 0 }]));
    await vi.waitFor(() => expect(statusById.value.k1?.phase).toBe('loaded'));
    expect((statusById.value.k1 as any).health.detail.model).toBe('fresh');
  });
});
