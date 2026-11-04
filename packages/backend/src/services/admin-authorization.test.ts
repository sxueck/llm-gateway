import { describe, expect, it, vi } from 'vitest';

const findById = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({ userDb: { findById } }));
import { isAdminPath, requireAdmin } from './admin-authorization.js';

describe('admin authorization', () => {
  it('protects admin and auth management routes, including query strings', () => {
    for (const path of ['/api/admin/config/stats?period=all', '/api/admin', '/api/auth/users', '/api/auth/lockouts/unlock', '/api/%61dmin/config/stats']) {
      expect(isAdminPath(path)).toBe(true);
    }
    for (const path of ['/api/auth/login', '/api/me/virtual-keys', '/api/administrator', '/v1/chat/completions']) {
      expect(isAdminPath(path)).toBe(false);
    }
  });

  it('checks the current database role rather than trusting an old token', async () => {
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    const request = { jwtVerify: vi.fn().mockResolvedValue(undefined), user: { userId: 'u1' } };
    findById.mockResolvedValueOnce({ role: 'user' }).mockResolvedValueOnce({ role: 'admin' });
    await requireAdmin(request as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(403);
    reply.code.mockClear();
    await requireAdmin(request as any, reply as any);
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('rejects invalid tokens before looking up a user', async () => {
    findById.mockClear();
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await requireAdmin({ jwtVerify: vi.fn().mockRejectedValue(new Error('bad token')) } as any, reply as any);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(findById).not.toHaveBeenCalled();
  });
});
