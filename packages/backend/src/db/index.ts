import * as connectionModule from "./connection.js";
import { createTables } from "./schema.js";
import { applyMigrations } from "./migrations.js";
import { appConfig } from "../config/index.js";
import { nodeOwnerError } from "../config/node.js";
import { isControlNode } from "../services/node-control.js";
import {
  startBufferFlush,
  stopBufferFlush,
  flushApiRequestBuffer,
} from "./utils/buffer.js";

// Re-export types (type-only to avoid runtime import)
export type {
  Model,
  ApiRequestBuffer,
} from "./types.js";

export { getDatabase, getPool, withTransaction } from "./connection.js";

export { createTables } from "./schema.js";

export { flushApiRequestBuffer as flushApiRequestBufferNow } from "./utils/buffer.js";

import { userRepository } from "./repositories/user.repository.js";
import { providerRepository } from "./repositories/provider.repository.js";
import { modelRepository } from "./repositories/model.repository.js";
import { virtualKeyRepository } from "./repositories/virtual-key.repository.js";
import { systemConfigRepository } from "./repositories/system-config.repository.js";
import { apiRequestRepository } from "./repositories/api-request.repository.js";
import { hourlySummaryRepository } from "./repositories/hourly-summary.repository.js";
import { routingConfigRepository } from "./repositories/routing-config.repository.js";
import { expertRoutingConfigRepository } from "./repositories/expert-routing-config.repository.js";
import { expertRoutingLogRepository } from "./repositories/expert-routing-log.repository.js";
import { expertRoutingSessionBindingRepository } from "./repositories/expert-routing-session-binding.repository.js";
import { costMappingRepository } from "./repositories/cost-mapping.repository.js";
import { circuitBreakerStatsRepository } from "./repositories/circuit-breaker-stats.repository.js";
import { promptSampleRepository } from "./repositories/prompt-sample.repository.js";
import { contextNormalizationRepository } from "./repositories/context-normalization.repository.js";
import {
  repositorySnapshotRepository,
  agentSearchRunRepository,
  agentSearchRunEventRepository,
  agentSearchUsageRepository,
} from "./repositories/agent-search.repository.js";
import {
  workerPluginRepository,
  userPluginEnrollmentRepository,
} from "./repositories/worker-plugin.repository.js";
import { alertReadRepository } from "./repositories/alert-read.repository.js";
import { expertRoutingTrainingRecordRepository } from "./repositories/expert-routing-training-record.repository.js";

// Export repositories with backward-compatible names
export const userDb = userRepository;
export const providerDb = providerRepository;
export const modelDb = modelRepository;
export const virtualKeyDb = virtualKeyRepository;
export const systemConfigDb = systemConfigRepository;
export const apiRequestDb = apiRequestRepository;
export const apiRequestHourlyDb = hourlySummaryRepository;
export const routingConfigDb = routingConfigRepository;
export const expertRoutingConfigDb = expertRoutingConfigRepository;
export const expertRoutingLogDb = expertRoutingLogRepository;
export const expertRoutingSessionBindingDb =
  expertRoutingSessionBindingRepository;
export const costMappingDb = costMappingRepository;
export const circuitBreakerStatsDb = circuitBreakerStatsRepository;
export const promptSampleDb = promptSampleRepository;
export const contextNormalizationDb = contextNormalizationRepository;
export const repositorySnapshotDb = repositorySnapshotRepository;
export const agentSearchRunDb = agentSearchRunRepository;
export const agentSearchRunEventDb = agentSearchRunEventRepository;
export const agentSearchUsageDb = agentSearchUsageRepository;
export const workerPluginDb = workerPluginRepository;
export const userPluginEnrollmentDb = userPluginEnrollmentRepository;
export const alertReadDb = alertReadRepository;
export const expertRoutingTrainingRecordDb = expertRoutingTrainingRecordRepository;

export async function initDatabase() {
  const pool = await connectionModule.initDatabase();
  const control = isControlNode(appConfig.node);

  const connection = await pool.getConnection();
  try {
    if (control) {
      console.log("[数据库] 开始创建表结构...");
      await createTables();
      console.log("[数据库] 表结构创建完成");

      console.log("[数据库] 开始应用数据库迁移...");
      try {
        await applyMigrations(connection as any);
        console.log("[数据库] 数据库迁移完成");
      } catch (migrationError: any) {
        console.error("[数据库] 迁移失败:", migrationError.message);
        console.error("[数据库] 迁移错误详情:", migrationError);
        throw migrationError;
      }
    } else {
      // 非控制节点不执行建表/迁移（由控制节点统一管理 schema），
      // 但必须确认 schema 已被控制节点迁移到位，否则直接失败以便尽早暴露。
      console.log(
        `[数据库] 非控制节点 ('${appConfig.node.id}')，跳过建表/迁移，校验 schema...`,
      );
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'providers'
           AND COLUMN_NAME = 'owner_node'`,
      );
      const result = rows as any[];
      const columnCount = Number(result?.[0]?.cnt || 0);
      if (columnCount < 1) {
        throw new Error(
          "[数据库] 当前 schema 缺少 providers.owner_node 列：请先启动控制节点完成数据库迁移，再启动本节点",
        );
      }
      console.log("[数据库] schema 校验通过 (providers.owner_node 已存在)");
    }

    // 配置漂移自检：owner_node 指向未配置节点时不会报错，只会让该供应商
    // 的流量全部 503（故障不接管是设计行为），因此在启动时点名到日志。
    {
      const [ownerRows] = await connection.query(
        `SELECT owner_node, COUNT(*) AS cnt FROM providers
         WHERE owner_node IS NOT NULL GROUP BY owner_node`,
      );
      for (const row of ownerRows as any[]) {
        const message = nodeOwnerError(String(row.owner_node), appConfig.node);
        if (message) {
          console.warn(`[数据库] ${message}（影响 ${row.cnt} 个供应商）`);
        }
      }
    }
  } finally {
    connection.release();
  }

  startBufferFlush();
  return pool;
}

export async function shutdownDatabase() {
  stopBufferFlush();
  await flushApiRequestBuffer();
  await connectionModule.shutdownDatabase();
}
