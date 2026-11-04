import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userDb, virtualKeyDb } from '../db/index.js';
import { userVirtualKeyRepository } from '../db/repositories/user-virtual-key.repository.js';
import { userApiRequestRepository } from '../db/repositories/user-api-request.repository.js';
import { requireAdmin } from '../services/admin-authorization.js';
import { memoryLogger } from '../services/logger.js';
import { VirtualKey } from '../types/index.js';

const apiRequestsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  startTime: z.coerce.number().int().min(0).optional(),
  endTime: z.coerce.number().int().min(0).optional(),
  status: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  virtualKeyId: z.string().trim().min(1).optional(),
});

const bindSchema = z.object({
  userId: z.string().trim().min(1),
  virtualKeyIds: z
    .array(z.string().trim().min(1))
    .min(1, 'virtualKeyIds 不能为空')
    .max(100, '单次最多绑定 100 个虚拟密钥'),
});

function notFound(param: string, message: string) {
  return {
    error: {
      message,
      type: 'invalid_request_error',
      param,
      code: 'not_found',
    },
  };
}

// Zod .parse 抛错若不就地收敛会撞上全局 error handler 的 500 分支；与
// virtual-keys.ts 同款插件级 handler，让校验失败以 400 信封返回。
function zodErrorHandler(error: any, request: any, reply: any) {
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;
    return reply.code(400).send({
      error: {
        message: issue?.message ?? '请求参数验证失败',
        type: 'invalid_request_error',
        param: issue?.path.length ? issue.path.join('.') : null,
        code: 'validation_error',
      },
    });
  }
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.code(error.statusCode).send({
      error: { message: error.message, type: 'invalid_request_error', param: null, code: 'invalid_request' },
    });
  }
  request.log.error(error);
  return reply.code(500).send({
    error: {
      message: '服务器内部错误',
      type: 'internal_error',
      param: null,
      code: 'internal_server_error',
    },
  });
}

type BoundVirtualKey = VirtualKey & { bound_at?: number };

// 与管理端列表同一 camelCase 形态；includePlaintext 控制是否带出明文
// （用户自助视图要明文，管理端绑定视图不需要——管理端有自己的明文入口）。
function serializeVirtualKey(vk: BoundVirtualKey, includePlaintext: boolean) {
  const base = {
    id: vk.id,
    name: vk.name,
    providerId: vk.provider_id,
    modelId: vk.model_id,
    routingStrategy: vk.routing_strategy,
    modelIds: vk.model_ids ? JSON.parse(vk.model_ids) : null,
    enabled: vk.enabled === 1,
    rateLimit: vk.rate_limit,
    cacheEnabled: vk.cache_enabled === 1,
    disableLogging: vk.disable_logging === 1,
    contextBudgetTokens: vk.context_budget_tokens ?? null,
    boundAt: vk.bound_at ?? null,
    createdAt: vk.created_at,
    updatedAt: vk.updated_at,
  };
  return includePlaintext ? { ...base, keyValue: vk.key_value } : base;
}

function emptyApiRequestPage(page: number, pageSize: number) {
  return { data: [], total: 0, page, pageSize, totalPages: 0 };
}

export async function userAccessRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
  fastify.setErrorHandler(zodErrorHandler);

  // 绑定密钥列表（含明文）。disable_logging=1 的密钥也会列出（绑定是管理员
  // 的显式决定），但它的请求历史按密钥自身口径对普通用户不可见。
  fastify.get('/virtual-keys', async (request) => {
    const keys = await userVirtualKeyRepository.getVirtualKeysByUserId(
      request.user.userId,
    );
    return { virtualKeys: keys.map((vk) => serializeVirtualKey(vk, true)) };
  });

  // 绑定密钥的请求历史（全部留存期内明细；历史汇总表只存聚合，不在此口径内）。
  fastify.get('/api-requests', async (request) => {
    const query = apiRequestsQuerySchema.parse(request.query ?? {});
    const boundIds = await userVirtualKeyRepository.listVirtualKeyIdsByUser(
      request.user.userId,
    );
    if (boundIds.length === 0) {
      return emptyApiRequestPage(query.page, query.pageSize);
    }

    // 客户端传入的 virtualKeyId 只有落在绑定集合内才生效；集合外的值返回
    // 空页而不是 403/404，避免用它探测任意密钥 ID 的绑定关系。
    if (query.virtualKeyId && !boundIds.includes(query.virtualKeyId)) {
      return emptyApiRequestPage(query.page, query.pageSize);
    }
    const scope = query.virtualKeyId ? [query.virtualKeyId] : boundIds;

    return await userApiRequestRepository.listForVirtualKeys({
      virtualKeyIds: scope,
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
      startTime: query.startTime,
      endTime: query.endTime,
      status: query.status,
      model: query.model,
    });
  });

  // 单条详情：未绑定 / 不存在 / 空绑定共用同一 404，防越权探测。
  fastify.get('/api-requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const boundIds = await userVirtualKeyRepository.listVirtualKeyIdsByUser(
      request.user.userId,
    );
    if (boundIds.length === 0) {
      return reply.code(404).send(notFound('id', '请求记录不存在'));
    }

    const detail = await userApiRequestRepository.getByIdForVirtualKeys(
      id,
      boundIds,
    );
    if (!detail) {
      return reply.code(404).send(notFound('id', '请求记录不存在'));
    }
    return detail;
  });
}

// Keep the guard local as well: this plugin may be registered under another prefix.
export async function userAccessAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request, reply) => {
    await requireAdmin(request, reply);
  });
  fastify.setErrorHandler(zodErrorHandler);

  fastify.get('/bindings', async () => {
    const bindings = await userVirtualKeyRepository.getAllBindings();
    return {
      bindings: bindings.map((binding) => ({
        userId: binding.user_id,
        username: binding.username,
        virtualKeyId: binding.virtual_key_id,
        virtualKeyName: binding.virtual_key_name,
        boundAt: binding.created_at,
      })),
    };
  });

  fastify.get('/users/:userId/bindings', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const user = await userDb.findById(userId);
    if (!user) {
      return reply.code(404).send(notFound('userId', '用户不存在'));
    }
    const keys = await userVirtualKeyRepository.getVirtualKeysByUserId(userId);
    return {
      userId,
      virtualKeys: keys.map((vk) => serializeVirtualKey(vk, false)),
    };
  });

  fastify.get('/virtual-keys/:virtualKeyId/bindings', async (request, reply) => {
    const { virtualKeyId } = request.params as { virtualKeyId: string };
    const vk = await virtualKeyDb.getById(virtualKeyId);
    if (!vk) {
      return reply.code(404).send(notFound('virtualKeyId', '虚拟密钥不存在'));
    }
    const users = await userVirtualKeyRepository.listBoundUsersByVirtualKey(
      virtualKeyId,
    );
    return {
      virtualKeyId,
      users: users.map((entry) => ({
        userId: entry.user_id,
        username: entry.username,
        boundAt: entry.bound_at,
      })),
    };
  });

  fastify.post('/bindings', async (request, reply) => {
    const body = bindSchema.parse(request.body);

    const user = await userDb.findById(body.userId);
    if (!user) {
      return reply.code(400).send({ error: '用户不存在' });
    }

    // 与 quotas/bulk 同款校验：逐个确认密钥存在，缺失的一并列出，不静默跳过。
    const missing: string[] = [];
    for (const id of body.virtualKeyIds) {
      if (!(await virtualKeyDb.getById(id))) missing.push(id);
    }
    if (missing.length > 0) {
      return reply
        .code(400)
        .send({ error: `虚拟密钥不存在: ${missing.join(', ')}` });
    }

    const result = await userVirtualKeyRepository.bind(
      body.userId,
      body.virtualKeyIds,
    );

    const operator = request.user.username;
    memoryLogger.info(
      `用户 ${user.username}(${body.userId}) 绑定虚拟密钥: 新增 ${result.bound.length} 个${
        result.alreadyBound.length > 0
          ? `，已绑定 ${result.alreadyBound.length} 个（幂等跳过）`
          : ''
      }（操作者 ${operator}）`,
      'UserAccess',
    );

    return {
      userId: body.userId,
      bound: result.bound,
      alreadyBound: result.alreadyBound,
    };
  });

  fastify.delete('/users/:userId/bindings/:virtualKeyId', async (request, reply) => {
    const { userId, virtualKeyId } = request.params as {
      userId: string;
      virtualKeyId: string;
    };

    const removed = await userVirtualKeyRepository.unbind(userId, virtualKeyId);
    if (!removed) {
      // 用户不存在与绑定不存在共用 404：这个端点只描述绑定关系本身。
      return reply.code(404).send(notFound('virtualKeyId', '绑定不存在'));
    }

    memoryLogger.info(
      `解除绑定: 用户 ${userId} × 密钥 ${virtualKeyId}（操作者 ${request.user.username}）`,
      'UserAccess',
    );

    return { userId, virtualKeyId, success: true };
  });

  fastify.delete('/users/:userId/bindings', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const user = await userDb.findById(userId);
    if (!user) {
      return reply.code(404).send(notFound('userId', '用户不存在'));
    }

    const removed = await userVirtualKeyRepository.unbindAllByUser(userId);
    memoryLogger.info(
      `解除用户 ${user.username}(${userId}) 的全部密钥绑定: ${removed} 个（操作者 ${request.user.username}）`,
      'UserAccess',
    );
    return { userId, removed };
  });
}
