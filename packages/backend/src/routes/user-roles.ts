import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';

export async function userRoleRoutes(fastify: FastifyInstance) {
  fastify.patch('/:id/role', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ role: z.enum(['admin', 'user']) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: '无效的角色', type: 'invalid_request_error', param: 'role', code: 'invalid_role' } });
    }
    try {
      await userDb.setRole(id, parsed.data.role);
    } catch (error) {
      if (error instanceof Error && error.message === '用户不存在') {
        return reply.code(404).send({ error: { message: error.message, type: 'invalid_request_error', param: 'id', code: 'not_found' } });
      }
      if (error instanceof Error && error.message === '不能移除最后一个管理员') {
        return reply.code(409).send({ error: { message: error.message, type: 'invalid_request_error', param: 'role', code: 'last_admin' } });
      }
      throw error;
    }
    memoryLogger.info(`用户角色变更 userId=${id} role=${parsed.data.role} operator=${request.user.userId}`, 'Auth');
    return { id, role: parsed.data.role };
  });
}
