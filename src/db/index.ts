// Import base modules
import * as connectionModule from './connection.js';
import { createTables } from './schema.js';
import { applyMigrations } from './migrations.js';
import { startBufferFlush, stopBufferFlush, flushApiRequestBuffer } from './utils/buffer.js';

 // Re-export types (type-only to avoid runtime import)
export type { Model, HealthTarget, HealthRun, ApiRequestBuffer } from './types.js';

// Re-export base connection utilities
export { getDatabase, getPool } from './connection.js';

// Re-export schema creation
export { createTables } from './schema.js';

// Re-export buffer utilities
export { flushApiRequestBuffer as flushApiRequestBufferNow } from './utils/buffer.js';

// Import repositories
import { userRepository } from './repositories/user.repository.js';
import { providerRepository } from './repositories/provider.repository.js';
import { modelRepository } from './repositories/model.repository.js';
import { virtualKeyRepository } from './repositories/virtual-key.repository.js';
import { systemConfigRepository } from './repositories/system-config.repository.js';
import { apiRequestRepository } from './repositories/api-request.repository.js';
import { routingConfigRepository } from './repositories/routing-config.repository.js';
import { expertRoutingConfigRepository } from './repositories/expert-routing-config.repository.js';
import { expertRoutingLogRepository } from './repositories/expert-routing-log.repository.js';
import { healthTargetRepository } from './repositories/health-target.repository.js';
import { healthRunRepository } from './repositories/health-run.repository.js';

// Export repositories with backward-compatible names
export const userDb = userRepository;
export const providerDb = providerRepository;
export const modelDb = modelRepository;
export const virtualKeyDb = virtualKeyRepository;
export const systemConfigDb = systemConfigRepository;
export const apiRequestDb = apiRequestRepository;
export const routingConfigDb = routingConfigRepository;
export const expertRoutingConfigDb = expertRoutingConfigRepository;
export const expertRoutingLogDb = expertRoutingLogRepository;
export const healthTargetDb = healthTargetRepository;
export const healthRunDb = healthRunRepository;

// Enhanced initDatabase that also creates tables and runs migrations
export async function initDatabase() {
  const pool = await connectionModule.initDatabase();

  const connection = await pool.getConnection();
  try {
    console.log('[数据库] 开始创建表结构...');
    await createTables();
    console.log('[数据库] 表结构创建完成');

    console.log('[数据库] 开始应用数据库迁移...');
    try {
      await applyMigrations(connection as any);
      console.log('[数据库] 数据库迁移完成');
    } catch (migrationError: any) {
      console.error('[数据库] 迁移失败:', migrationError.message);
      console.error('[数据库] 迁移错误详情:', migrationError);
      throw migrationError;
    }
  } finally {
    connection.release();
  }

  startBufferFlush();
  return pool;
}

// Enhanced shutdownDatabase
export async function shutdownDatabase() {
  stopBufferFlush();
  await flushApiRequestBuffer();
  await connectionModule.shutdownDatabase();
}
