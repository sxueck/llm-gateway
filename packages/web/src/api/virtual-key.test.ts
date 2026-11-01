import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock('@/utils/request', () => ({ default: request }));

import { virtualKeyApi } from './virtual-key'; // ast-grep-ignore: esm-relative-specifier-ext — Vite web import convention

describe('virtualKeyApi quota period routing', () => {
  it('keeps the daily GET byte-identical to the pre-weekly wire format', async () => {
    request.get.mockResolvedValue({ quotas: [] });

    await virtualKeyApi.getQuotas('k1');
    await virtualKeyApi.getQuotas('k1', 'daily');

    expect(request.get).toHaveBeenCalledTimes(2);
    expect(request.get).toHaveBeenNthCalledWith(1, '/admin/virtual-keys/quotas', {
      params: { virtualKeyId: 'k1' },
    });
    expect(request.get).toHaveBeenNthCalledWith(2, '/admin/virtual-keys/quotas', {
      params: { virtualKeyId: 'k1' },
    });
  });

  it('sends period=weekly for the natural-week window', async () => {
    request.get.mockResolvedValue({ quotas: [] });

    await virtualKeyApi.getQuotas('k1', 'weekly');

    expect(request.get).toHaveBeenCalledWith('/admin/virtual-keys/quotas', {
      params: { virtualKeyId: 'k1', period: 'weekly' },
    });
  });

  it('passes the bulk body through untouched, with or without a period', async () => {
    request.put.mockResolvedValue({ success: true });

    await virtualKeyApi.updateQuotasBulk({
      virtualKeyIds: ['k1', 'k2'],
      quotas: [{ model: 'sonnet', limitMillions: 2 }],
    });
    await virtualKeyApi.updateQuotasBulk({
      virtualKeyIds: ['k1'],
      quotas: [{ model: 'sonnet', limitMillions: null }],
      period: 'weekly',
    });

    expect(request.put).toHaveBeenNthCalledWith(1, '/admin/virtual-keys/quotas/bulk', {
      virtualKeyIds: ['k1', 'k2'],
      quotas: [{ model: 'sonnet', limitMillions: 2 }],
    });
    expect(request.put).toHaveBeenNthCalledWith(2, '/admin/virtual-keys/quotas/bulk', {
      virtualKeyIds: ['k1'],
      quotas: [{ model: 'sonnet', limitMillions: null }],
      period: 'weekly',
    });
  });
});
