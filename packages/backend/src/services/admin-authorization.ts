import type { FastifyReply, FastifyRequest } from 'fastify';
import { userDb } from '../db/index.js';

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  // Invalid JWTs must receive 401 at the authentication boundary.
  // ast-grep-ignore: no-catch-swallow
  } catch {
    return reply.code(401).send({ error: { message: '未授权', type: 'invalid_request_error', param: null, code: 'unauthorized' } });
  }
  const user = await userDb.findById(request.user.userId);
  if (!user || user.role !== 'admin') {
    return reply.code(403).send({ error: { message: '需要管理员权限', type: 'invalid_request_error', param: null, code: 'forbidden' } });
  }
}

export function isAdminPath(url: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?', 1)[0]);
  // Malformed paths must fail closed.
  // ast-grep-ignore: no-catch-swallow
  } catch {
    return true;
  }
  return path === '/api/admin' || path.startsWith('/api/admin/') ||
    path === '/api/auth/users' || path.startsWith('/api/auth/users/') ||
    path === '/api/auth/lockouts' || path.startsWith('/api/auth/lockouts/');
}
