import { describe, expect, it, vi } from 'vitest';

const setRole = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({ userDb: { setRole } }));
vi.mock('../services/logger.js', () => ({ memoryLogger: { info: vi.fn() } }));
import { userRoleRoutes } from './user-roles.js';

describe('user role management', () => {
  it('updates valid roles and protects the last admin', async () => {
    const app = { patch: vi.fn() };
    await userRoleRoutes(app as any);
    const handler = app.patch.mock.calls[0][1];
    const request = { params: { id: 'u1' }, body: { role: 'user' }, user: { userId: 'admin' } };
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    setRole.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('不能移除最后一个管理员'));
    expect(await handler(request, reply)).toEqual({ id: 'u1', role: 'user' });
    await handler(request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
  });
});
