import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appConfig } from './config/index.js';
import { initDatabase, apiRequestDb, systemConfigDb } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { providerRoutes } from './routes/providers.js';
import { modelRoutes } from './routes/models.js';
import { virtualKeyRoutes } from './routes/virtual-keys.js';
import { configRoutes } from './routes/config.js';
import { publicConfigRoutes } from './routes/public-config.js';
import { proxyRoutes } from './routes/proxy.js';
import { memoryLogger } from './services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({
  logger: {
    level: appConfig.logLevel,
    transport: appConfig.nodeEnv === 'development' ? {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    } : undefined,
  },
});

await fastify.register(cors, {
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-portkey-config', 'Accept', 'Origin'],
});

await fastify.register(jwt, {
  secret: appConfig.jwtSecret,
});

await fastify.register(fastifyStatic, {
  root: resolve(__dirname, '..', 'portkey-config'),
  prefix: '/portkey-config/',
  decorateReply: false,
});

fastify.decorate('authenticate', async function(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: '未授权' });
  }
});

await initDatabase();

memoryLogger.info('Database initialized', 'System');

const corsEnabledCfg = systemConfigDb.get('cors_enabled');
const corsEnabled = corsEnabledCfg ? corsEnabledCfg.value === 'true' : true;

if (corsEnabled) {
  memoryLogger.info('CORS 跨域支持已启用', 'System');
} else {
  memoryLogger.warn('CORS 跨域支持已禁用，浏览器端应用可能无法正常访问', 'System');
}

fastify.addHook('onRequest', async (request, reply) => {
  const corsEnabledCfg = systemConfigDb.get('cors_enabled');
  const corsEnabled = corsEnabledCfg ? corsEnabledCfg.value === 'true' : true;

  if (!corsEnabled && request.headers.origin) {
    reply.header('Access-Control-Allow-Origin', 'null');
    reply.header('Access-Control-Allow-Credentials', 'false');
  }
});

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: Date.now() };
});

await fastify.register(proxyRoutes);
await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(publicConfigRoutes, { prefix: '/api/admin/config' });
await fastify.register(providerRoutes, { prefix: '/api/admin/providers' });
await fastify.register(modelRoutes, { prefix: '/api/admin/models' });
await fastify.register(virtualKeyRoutes, { prefix: '/api/admin/virtual-keys' });
await fastify.register(configRoutes, { prefix: '/api/admin/config' });

memoryLogger.info('Routes registered', 'System');

fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error);
  
  if (error.validation) {
    return reply.code(400).send({
      error: '请求参数验证失败',
      details: error.validation,
    });
  }

  reply.code(error.statusCode || 500).send({
    error: error.message || '服务器内部错误',
  });
});

async function cleanOldApiRequests() {
  try {
    const deletedCount = await apiRequestDb.cleanOldRecords(appConfig.apiRequestLogRetentionDays);
    if (deletedCount > 0) {
      memoryLogger.info(
        `自动清理旧请求日志: 删除 ${deletedCount} 条记录 (保留 ${appConfig.apiRequestLogRetentionDays} 天)`,
        'System'
      );
    }
  } catch (error: any) {
    memoryLogger.error(`自动清理请求日志失败: ${error.message}`, 'System');
  }
}

try {
  await fastify.listen({ port: appConfig.port, host: '0.0.0.0' });
  console.log(`Server listening on http://localhost:${appConfig.port}`);
  memoryLogger.info(`Server started on port ${appConfig.port}`, 'System');

  await cleanOldApiRequests();

  setInterval(cleanOldApiRequests, 24 * 60 * 60 * 1000);
  memoryLogger.info(
    `已启动请求日志自动清理任务，每 24 小时执行一次，保留 ${appConfig.apiRequestLogRetentionDays} 天`,
    'System'
  );
} catch (err) {
  fastify.log.error(err);
  memoryLogger.error(`Failed to start server: ${err}`, 'System');
  process.exit(1);
}

