import { getDatabase } from "../db/connection.js";
import {
  contextNormalizationDb,
  expertRoutingSessionBindingDb,
  systemConfigDb,
} from "../db/index.js";
import { memoryLogger } from "./logger.js";

export const DB_MAINTENANCE_SETTINGS_KEY = "db_maintenance_settings";
export const DB_MAINTENANCE_LAST_RUN_KEY = "db_maintenance_last_run";

/** 按创建时间清理的目标 -> 时间列。api_requests 删除会级联清理 api_request_payloads。 */
const AGE_PURGE_TARGETS: Record<string, string> = {
  api_requests: "created_at",
  expert_routing_logs: "created_at",
  expert_routing_training_records: "created_at",
  circuit_breaker_events: "triggered_at",
  // 统计/截止时间按 created_at；删除走 contextNormalizationDb 的批量清理。
  context_switch_events: "created_at",
};

/** 会话绑定类表：idle/absolute 任一过期即失效，复用各自仓库的批量清理。 */
const EXPIRED_PURGE_TARGETS = [
  "expert_routing_session_bindings",
  "session_context_bindings",
] as const;

export type PurgeMode = "age" | "expired";

export interface TableSizeInfo {
  table: string;
  engine: string | null;
  rows: number;
  dataMb: number;
  indexMb: number;
  freeMb: number;
  totalMb: number;
}

export interface PurgePlan {
  table: string;
  mode: PurgeMode;
  cutoffAt: number | null;
  estimatedRows: number;
}

export interface PurgeResult {
  table: string;
  deleted: number;
  batches: number;
}

export interface MaintenanceSettings {
  retentionDays: Record<string, number>;
}

export interface LastRunRecord {
  type: "purge" | "optimize";
  at: number;
  summary: string;
}

export interface OptimizeResult {
  table: string;
  ok: boolean;
  messages: string[];
}

export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
const PURGE_BATCH_SIZE = 2000;
const PURGE_MAX_BATCHES = 50;

export function listPurgeTargets(): string[] {
  return [...Object.keys(AGE_PURGE_TARGETS), ...EXPIRED_PURGE_TARGETS];
}

export function isValidPurgeTarget(table: string): boolean {
  return (
    table in AGE_PURGE_TARGETS ||
    (EXPIRED_PURGE_TARGETS as readonly string[]).includes(table)
  );
}

export function normalizeSettings(raw: unknown): MaintenanceSettings {
  const retentionDays: Record<string, number> = {};
  const source =
    raw && typeof raw === "object" ? (raw as { retentionDays?: unknown }) : undefined;
  if (source && typeof source.retentionDays === "object" && source.retentionDays) {
    for (const [table, value] of Object.entries(source.retentionDays as Record<string, unknown>)) {
      if (!(table in AGE_PURGE_TARGETS)) continue;
      const days = Math.floor(Number(value));
      if (!Number.isFinite(days)) continue;
      retentionDays[table] = Math.min(
        MAX_RETENTION_DAYS,
        Math.max(MIN_RETENTION_DAYS, days),
      );
    }
  }
  return { retentionDays };
}

export async function getMaintenanceSettings(): Promise<MaintenanceSettings> {
  const row = await systemConfigDb.get(DB_MAINTENANCE_SETTINGS_KEY);
  if (!row?.value) return { retentionDays: {} };
  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return { retentionDays: {} };
  }
}

export async function saveMaintenanceSettings(settings: MaintenanceSettings): Promise<void> {
  await systemConfigDb.set(
    DB_MAINTENANCE_SETTINGS_KEY,
    JSON.stringify(normalizeSettings(settings)),
    "数据库整理：按表保留天数策略",
  );
}

export function resolveCutoff(table: string, settings: MaintenanceSettings, now: number): number {
  const days = settings.retentionDays[table] ?? DEFAULT_RETENTION_DAYS;
  return now - days * 24 * 60 * 60 * 1000;
}

export async function getTableSizes(): Promise<TableSizeInfo[]> {
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT table_name AS table_name, engine AS engine,
              table_rows AS table_rows,
              data_length / 1024 / 1024 AS data_mb,
              index_length / 1024 / 1024 AS index_mb,
              data_free / 1024 / 1024 AS free_mb
       FROM information_schema.TABLES
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
       ORDER BY (data_length + index_length) DESC`,
    );
    return (rows as Array<Record<string, unknown>>).map((row) => {
      const dataMb = Number(row.data_mb) || 0;
      const indexMb = Number(row.index_mb) || 0;
      return {
        table: String(row.table_name ?? ""),
        engine: row.engine === null ? null : String(row.engine),
        rows: Number(row.table_rows) || 0,
        dataMb: Math.round(dataMb * 100) / 100,
        indexMb: Math.round(indexMb * 100) / 100,
        freeMb: Math.round((Number(row.free_mb) || 0) * 100) / 100,
        totalMb: Math.round((dataMb + indexMb) * 100) / 100,
      };
    });
  } finally {
    conn.release();
  }
}

async function countAgePurgeable(table: string, timeColumn: string, cutoff: number): Promise<number> {
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(`SELECT COUNT(*) AS total FROM ?? WHERE ?? <= ?`, [
      table,
      timeColumn,
      cutoff,
    ]);
    return Number((rows as Array<Record<string, unknown>>)[0]?.total) || 0;
  } finally {
    conn.release();
  }
}

async function countExpiredBindings(table: string, now: number): Promise<number> {
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS total FROM ?? WHERE idle_expires_at <= ? OR absolute_expires_at <= ?`,
      [table, now, now],
    );
    return Number((rows as Array<Record<string, unknown>>)[0]?.total) || 0;
  } finally {
    conn.release();
  }
}

/** 生成清理计划（只读统计，不删除）。 */
export async function buildPurgePlans(
  targets: string[],
  settings: MaintenanceSettings,
  now: number = Date.now(),
): Promise<PurgePlan[]> {
  const plans: PurgePlan[] = [];
  for (const table of targets) {
    if (!isValidPurgeTarget(table)) {
      throw new Error(`unknown purge target: ${table}`);
    }
    if (table in AGE_PURGE_TARGETS) {
      const cutoffAt = resolveCutoff(table, settings, now);
      const estimatedRows = await countAgePurgeable(table, AGE_PURGE_TARGETS[table], cutoffAt);
      plans.push({ table, mode: "age", cutoffAt, estimatedRows });
    } else {
      const estimatedRows = await countExpiredBindings(table, now);
      plans.push({ table, mode: "expired", cutoffAt: now, estimatedRows });
    }
  }
  return plans;
}

async function purgeAgeTarget(
  table: string,
  timeColumn: string,
  cutoff: number,
  batchSize: number,
): Promise<PurgeResult> {
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    let deleted = 0;
    let batches = 0;
    while (batches < PURGE_MAX_BATCHES) {
      const [result] = await conn.query(`DELETE FROM ?? WHERE ?? <= ? LIMIT ?`, [
        table,
        timeColumn,
        cutoff,
        batchSize,
      ]);
      const affected = (result as { affectedRows?: number }).affectedRows || 0;
      deleted += affected;
      batches += 1;
      if (affected < batchSize) break;
    }
    return { table, deleted, batches };
  } finally {
    conn.release();
  }
}

async function purgeExpiredTarget(table: string, now: number, batchSize: number): Promise<PurgeResult> {
  let deleted = 0;
  let batches = 0;
  while (batches < PURGE_MAX_BATCHES) {
    const affected =
      table === "expert_routing_session_bindings"
        ? await expertRoutingSessionBindingDb.cleanupExpired(now, batchSize)
        : await contextNormalizationDb.cleanupExpiredBindings(now, batchSize);
    deleted += affected;
    batches += 1;
    if (affected < batchSize) break;
  }
  return { table, deleted, batches };
}

async function purgeSwitchEvents(
  cutoff: number,
  now: number,
  batchSize: number,
): Promise<PurgeResult> {
  let deleted = 0;
  let batches = 0;
  while (batches < PURGE_MAX_BATCHES) {
    const affected = await contextNormalizationDb.cleanupOldSwitchEvents(
      now,
      now - cutoff,
      batchSize,
    );
    deleted += affected;
    batches += 1;
    if (affected < batchSize) break;
  }
  return { table: "context_switch_events", deleted, batches };
}

export async function runPurge(
  targets: string[],
  settings: MaintenanceSettings,
  batchSize: number = PURGE_BATCH_SIZE,
  now: number = Date.now(),
): Promise<PurgeResult[]> {
  const results: PurgeResult[] = [];
  for (const table of targets) {
    if (table === "context_switch_events") {
      results.push(await purgeSwitchEvents(resolveCutoff(table, settings, now), now, batchSize));
    } else if (table in AGE_PURGE_TARGETS) {
      results.push(
        await purgeAgeTarget(table, AGE_PURGE_TARGETS[table], resolveCutoff(table, settings, now), batchSize),
      );
    } else if ((EXPIRED_PURGE_TARGETS as readonly string[]).includes(table)) {
      results.push(await purgeExpiredTarget(table, now, batchSize));
    } else {
      throw new Error(`unknown purge target: ${table}`);
    }
  }
  memoryLogger.info(
    `DB maintenance purge: ${results.map((r) => `${r.table}=${r.deleted}`).join(", ")}`,
    "DBMaintenance",
  );
  return results;
}

async function tableExists(table: string): Promise<boolean> {
  const pool = getDatabase();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table],
    );
    return Number((rows as Array<Record<string, unknown>>)[0]?.total) > 0;
  } finally {
    conn.release();
  }
}

export async function optimizeTables(tables: string[]): Promise<OptimizeResult[]> {
  const results: OptimizeResult[] = [];
  for (const table of tables) {
    if (!(await tableExists(table))) {
      results.push({ table, ok: false, messages: ["table not found"] });
      continue;
    }
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`OPTIMIZE TABLE ??`, [table]);
      const messages = (rows as Array<Record<string, unknown>>).map(
        (row) => `${row.Msg_type ?? row.msg_type}: ${row.Msg_text ?? row.msg_text}`,
      );
      const ok = !messages.some((m) => /^error/i.test(m));
      results.push({ table, ok, messages });
    } finally {
      conn.release();
    }
  }
  memoryLogger.info(
    `DB maintenance optimize: ${results.map((r) => `${r.table}=${r.ok ? "ok" : "failed"}`).join(", ")}`,
    "DBMaintenance",
  );
  return results;
}

export async function recordLastRun(record: LastRunRecord): Promise<void> {
  await systemConfigDb.set(
    DB_MAINTENANCE_LAST_RUN_KEY,
    JSON.stringify(record),
    "数据库整理最近一次执行记录",
  );
}

export async function getLastRun(): Promise<LastRunRecord | null> {
  const row = await systemConfigDb.get(DB_MAINTENANCE_LAST_RUN_KEY);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as LastRunRecord;
    return parsed && (parsed.type === "purge" || parsed.type === "optimize") ? parsed : null;
  } catch {
    return null;
  }
}
