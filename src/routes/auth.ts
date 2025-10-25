import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { userDb, systemConfigDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { validateUsername, validatePassword } from '../utils/validation.js';

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

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const allowCfg = systemConfigDb.get('allow_registration');
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

    const existingUser = userDb.findByUsername(body.username);
    if (existingUser) {
      return reply.code(400).send({ error: '用户名已存在' });
    }

    const user = await userDb.create({
      id: nanoid(),
      username: body.username,
      password_hash: hashPassword(body.password),
    });

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

    const user = userDb.findByUsername(body.username);
    if (!user) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }

    if (!verifyPassword(body.password, user.password_hash)) {
      return reply.code(401).send({ error: '用户名或密码错误' });
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

  fastify.get('/profile', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const user = userDb.findById(request.user.userId);
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
    return userDb.getAll();
  });
}

