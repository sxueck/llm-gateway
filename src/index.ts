import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { appConfig, setPublicUrl } from './config/index.js';
import { initDatabase, apiRequestDb, systemConfigDb, shutdownDatabase, getDatabase } from './db/index.js';
import { migrateFromSQLite } from './db/migration-from-sqlite.js';
import { existsSync } from 'fs';
import { authRoutes } from './routes/auth.js';
import { providerRoutes } from './routes/providers.js';
import { modelRoutes } from './routes/models.js';
import { virtualKeyRoutes } from './routes/virtual-keys.js';
import { configRoutes } from './routes/config.js';
import { publicConfigRoutes } from './routes/public-config.js';
import { proxyRoutes } from './routes/proxy.js';
import { anthropicRoutes } from './routes/anthropic.js';
import { modelPresetsRoutes } from './routes/model-presets.js';
import { expertRoutingRoutes } from './routes/expert-routing.js';
import { memoryLogger } from './services/logger.js';
import { modelPresetsService } from './services/model-presets.js';
import { demoModeService } from './services/demo-mode.js';

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
  allowedHeaders: ['Content-Type', 'Authorization', 'x-portkey-config', 'Accept', 'Origin', 'anthropic-version', 'x-api-key'],
});

await fastify.register(jwt, {
  secret: appConfig.jwtSecret,
});

await fastify.register(fastifyStatic, {
  root: resolve(__dirname, '..', 'web', 'dist'),
  prefix: '/',
});

fastify.decorate('authenticate', async function(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err: any) {
    reply.code(401).send({
      error: {
        message: '未授权',
        type: 'invalid_request_error',
        param: null,
        code: 'unauthorized'
      }
    });
    throw err;
  }
});

await initDatabase();

memoryLogger.info('Database initialized', 'System');

if (existsSync(appConfig.dbPath)) {
  memoryLogger.info('检测到 SQLite 数据库文件，开始迁移到 MySQL...', 'System');
  try {
    const pool = getDatabase();
    const connection = await pool.getConnection();

    const result = await migrateFromSQLite(
      appConfig.dbPath,
      connection as any,
      (progress) => {
        memoryLogger.info(
          `迁移进度: ${progress.table} (${progress.current}/${progress.total})`,
          'Migration'
        );
      }
    );

    connection.release();

    if (result.success) {
      memoryLogger.info(`数据迁移成功: ${result.message}`, 'Migration');
      memoryLogger.info(`已迁移的表: ${result.migratedTables.join(', ')}`, 'Migration');
    } else {
      memoryLogger.error(`数据迁移失败: ${result.message}`, 'Migration');
    }
  } catch (error: any) {
    memoryLogger.error(`数据迁移异常: ${error.message}`, 'Migration');
  }
}



const publicUrlCfg = await systemConfigDb.get('public_url');
if (publicUrlCfg) {
  setPublicUrl(publicUrlCfg.value);
  memoryLogger.info(`使用自定义 LLM Gateway URL: ${publicUrlCfg.value}`, 'System');
} else {
  memoryLogger.info(`使用默认 LLM Gateway URL: ${appConfig.publicUrl}`, 'System');
}

const corsEnabledCfg = await systemConfigDb.get('cors_enabled');
const corsEnabled = corsEnabledCfg ? corsEnabledCfg.value === 'true' : true;

if (corsEnabled) {
  memoryLogger.info('CORS 跨域支持已启用', 'System');
} else {
  memoryLogger.warn('CORS 跨域支持已禁用，浏览器端应用可能无法正常访问', 'System');
}

fastify.addHook('onRequest', async (request, reply) => {
  const corsEnabledCfg = await systemConfigDb.get('cors_enabled');
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
await fastify.register(anthropicRoutes);
await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(publicConfigRoutes, { prefix: '/api/public' });
await fastify.register(providerRoutes, { prefix: '/api/admin/providers' });
await fastify.register(modelRoutes, { prefix: '/api/admin/models' });
await fastify.register(virtualKeyRoutes, { prefix: '/api/admin/virtual-keys' });
await fastify.register(configRoutes, { prefix: '/api/admin/config' });
await fastify.register(modelPresetsRoutes, { prefix: '/api/admin/model-presets' });
await fastify.register(expertRoutingRoutes, { prefix: '/api/admin/expert-routing' });

memoryLogger.info('Routes registered', 'System');

fastify.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.code(404).send({
      error: {
        message: '未找到请求的资源',
        type: 'invalid_request_error',
        param: null,
        code: 'not_found'
      }
    });
  } else {
    return reply.type('text/html').code(200).sendFile('index.html');
  }
});

fastify.setErrorHandler((error: any, request, reply) => {
  fastify.log.error(error);

  if (error.validation) {
    return reply.code(400).send({
      error: {
        message: '请求参数验证失败',
        type: 'invalid_request_error',
        param: null,
        code: 'validation_error'
      }
    });
  }

  reply.code(error.statusCode || 500).send({
    error: {
      message: error.message || '服务器内部错误',
      type: 'internal_error',
      param: null,
      code: 'internal_server_error'
    }
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

async function checkAndUpdateModelPresets() {
  try {
    if (modelPresetsService.shouldAutoUpdate()) {
      memoryLogger.info('检测到模型预设需要更新，开始自动更新...', 'System');
      const result = await modelPresetsService.updateFromRemote();
      if (result.success) {
        memoryLogger.info(result.message, 'System');
      } else {
        memoryLogger.warn(`模型预设更新失败: ${result.message}`, 'System');
      }
    } else {
      const stats = modelPresetsService.getStats();
      memoryLogger.info(`模型预设库已加载: ${stats.totalModels} 个模型`, 'System');
    }
  } catch (error: any) {
    memoryLogger.error(`模型预设检查失败: ${error.message}`, 'System');
  }
}

try {
  await fastify.listen({ port: appConfig.port, host: '0.0.0.0' });
  console.log(`Server listening on http://localhost:${appConfig.port}`);
  memoryLogger.info(`Server started on port ${appConfig.port}`, 'System');

  setInterval(cleanOldApiRequests, 24 * 60 * 60 * 1000);
  memoryLogger.info(
    `已启动请求日志自动清理任务，每 24 小时执行一次，保留 ${appConfig.apiRequestLogRetentionDays} 天`,
    'System'
  );

  await checkAndUpdateModelPresets();

  setInterval(checkAndUpdateModelPresets, 24 * 60 * 60 * 1000);
  memoryLogger.info('已启动模型预设自动更新任务，每 24 小时检查一次', 'System');

  await demoModeService.start();
} catch (err: any) {
  fastify.log.error(err);
  memoryLogger.error(`Failed to start server: ${err}`, 'System');
  process.exit(1);
}

const gracefulShutdown = async (signal: string) => {
  memoryLogger.info(`收到 ${signal} 信号，开始优雅关闭...`, 'System');

  try {
    demoModeService.stop();
    memoryLogger.info('演示模式服务已停止', 'System');

    await fastify.close();
    memoryLogger.info('Fastify 服务已关闭', 'System');

    await shutdownDatabase();
    memoryLogger.info('数据库已安全关闭', 'System');

    process.exit(0);
  } catch (err: any) {
    memoryLogger.error(`优雅关闭失败: ${err}`, 'System');
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (err) => {
  memoryLogger.error(`未捕获的异常: ${err.stack}`, 'System');
  await gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason, promise) => {
  memoryLogger.error(`未处理的 Promise 拒绝: ${reason}`, 'System');
  await gracefulShutdown('unhandledRejection');
});
