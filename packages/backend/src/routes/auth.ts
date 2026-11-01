import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { userDb, systemConfigDb } from '../db/index.js';
import { hashPassword } from '../utils/crypto.js';
import { validateUsername, validatePassword } from '../utils/validation.js';
import {
  loginLockoutService,
  normalizeClientIp,
  resolveClientIp,
  type LoginAttemptResult,
} from '../services/login-lockout.js';
import { memoryLogger } from '../services/logger.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string; username: string };
    user: { userId: string; username: string };
  }
}

const registerSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const lockoutTargetSchema = z.object({
  ip: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const allowCfg = await systemConfigDb.get('allow_registration');
    if (allowCfg && allowCfg.value === 'false') {
      return reply.code(403).send({ error: '当前已关闭用户注册' });
    }

    const usernameValidation = validateUsername(body.username);
    if (!usernameValidation.valid) {
      return reply.code(400).send({ error: usernameValidation.message });
    }

    const passwordValidation = validatePassword(body.password);
    if (!passwordValidation.valid) {
      return reply.code(400).send({ error: passwordValidation.message });
    }

    const existingUser = await userDb.findByUsername(body.username);
    if (existingUser) {
      return reply.code(400).send({ error: '用户名已存在' });
    }

    const isFirstUser = (await userDb.getAll()).length === 0;

    const user = await userDb.create({
      id: nanoid(),
      username: body.username,
      password_hash: hashPassword(body.password),
    });

    if (isFirstUser) {
      await systemConfigDb.set('allow_registration', 'false', '是否允许新用户注册');
    }

    const token = fastify.jwt.sign({ userId: user.id, username: user.username });

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
      },
    };
  });

  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const ip = resolveClientIp(request.ip, request.headers['x-forwarded-for']);

    let result: LoginAttemptResult;
    try {
      result = await loginLockoutService.attemptLogin(ip, body.username, body.password);
    } catch (error) {
      // fail-closed：记账不可用就不放行，但收敛成信封并留日志，不退化成无痕的裸 500。
      memoryLogger.warn(
        `登录封锁异常，已拒绝本次登录: ${error instanceof Error ? error.message : String(error)}`,
        'Auth',
      );
      return reply.code(503).send({ error: '登录暂时不可用，请稍后重试' });
    }

    if (result.status === 'locked') {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000));
      // 报剩余时间而不报总时长：总时长随常量漂移，前者才是调用方真正要等的。
      const retryAfterMinutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      // RFC 6585：429 同时给出 Retry-After 头，供 curl / 网关等不读 body 的调用方使用。
      return reply
        .code(429)
        .header('Retry-After', String(retryAfterSeconds))
        .send({
          error: `登录尝试次数过多，该来源对此账号已临时封锁，请约 ${retryAfterMinutes} 分钟后再试`,
          retryAfterSeconds,
        });
    }

    if (result.status === 'busy') {
      // 背压而非封锁：不入队、不记账，1s 后重试即可。
      return reply
        .code(429)
        .header('Retry-After', '1')
        .send({ error: '登录请求过于频繁，请稍后重试', retryAfterSeconds: 1 });
    }

    if (result.status === 'bad_credentials' || !result.user) {
      // 不存在与错口令共用文案，不给用户名枚举留口子
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    const token = fastify.jwt.sign({ userId: result.user.id, username: result.user.username });

    return {
      token,
      user: {
        id: result.user.id,
        username: result.user.username,
      },
    };
  });

  fastify.get('/profile', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const user = await userDb.findById(request.user.userId);
    if (!user) {
      throw new Error('用户不存在');
    }

    return {
      id: user.id,
      username: user.username,
    };
  });

  fastify.get('/users', {
    onRequest: [fastify.authenticate],
  }, async () => {
    return await userDb.getAll();
  });

  // 否则误锁共享出口 IP 后，被锁在外的管理员只能手工清库。
  fastify.get('/lockouts', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const { ip } = lockoutTargetSchema.parse(request.query);
    return await loginLockoutService.listLockouts(ip);
  });

  fastify.post('/lockouts/unlock', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const { ip } = lockoutTargetSchema.parse(request.body);
    const normalized = normalizeClientIp(ip);
    const cleared = await loginLockoutService.unlockIp(normalized);
    memoryLogger.info(
      `解除登录封锁 IP=${normalized}（清理 ${cleared} 个账号桶，操作者 ${request.user.username}）`,
      'Auth',
    );
    return { ip: normalized, cleared };
  });
}

