import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/utils/request', () => ({ default: request }));

import { userAccessApi } from '@/api/user-access';

describe('userAccessApi', () => {
  it('retrieves all users bound to a virtual key', async () => {
    const response = { virtualKeyId: 'key/1', users: [
      { userId: 'u1', username: 'alice', boundAt: 1 },
      { userId: 'u2', username: 'bob', boundAt: 2 },
    ] };
    request.get.mockResolvedValue(response);
    await expect(userAccessApi.getVirtualKeyBindings('key/1')).resolves.toEqual(response);
    expect(request.get).toHaveBeenCalledWith('/admin/user-access/virtual-keys/key%2F1/bindings');
  });
});
