import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/utils/request', () => ({ default: request }));

import { meApi } from '@/api/me';

describe('meApi self-scope endpoints', () => {
  it('lists my virtual keys under /me/virtual-keys', async () => {
    request.get.mockResolvedValue({ virtualKeys: [] });

    await meApi.getVirtualKeys();

    expect(request.get).toHaveBeenCalledWith('/me/virtual-keys');
  });

  it('lists my api requests with filter params passed through', async () => {
    request.get.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });

    await meApi.getApiRequests({ page: 2, pageSize: 50, status: 'error', virtualKeyId: 'k1' });

    expect(request.get).toHaveBeenCalledWith('/me/api-requests', {
      params: { page: 2, pageSize: 50, status: 'error', virtualKeyId: 'k1' },
    });
  });

  it('fetches a single request under my scope', async () => {
    request.get.mockResolvedValue({ id: 'r1' });

    await meApi.getApiRequestById('r1');

    expect(request.get).toHaveBeenCalledWith('/me/api-requests/r1');
  });
});
