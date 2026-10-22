import * as cron from 'node-cron';
import { readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { agentSearchRunDb, agentSearchRunEventDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { cleanupExpiredSnapshots } from '../snapshot/snapshot.service.js';
import { SNAPSHOT_RETENTION_MS } from '../snapshot/snapshot.service.js';

let cleanupJob: cron.ScheduledTask | null = null;

// 事件保留期：run 过期后事件再留 7 天（usage 聚合永久保留，但事件被删后
// 聚合就无法回溯执行细节 —— 这是调研结论里明确的缺口）；cron 每 5 分钟
// 有界批删，大 backlog 分次排干。
const DEFAULT_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = Number(
  process.env.AGENT_EVENT_RETENTION_MS || DEFAULT_EVENT_RETENTION_MS,
);
const EVENT_SWEEP_BATCH = 100;

export async function runAgentSearchCleanup(): Promise<{ snapshots: number; runs: number; orphanDirs: number; eventsSwept: number }> {
  const snapshots = await cleanupExpiredSnapshots();

  // run 体（密文/结果）在 expires_at 即失效；事件时间线与之解耦，
  // 保留期内仍可从 admin 详情页回看执行过程。
  const expiredRuns = await agentSearchRunDb.findExpired(Date.now());
  for (const run of expiredRuns) {
    await agentSearchRunDb.markExpired(run.id);
  }

  // 有界事件回收：只处理保留期已满的 run，每次最多 EVENT_SWEEP_BATCH 个
  const eventsCutoff = Date.now() - EVENT_RETENTION_MS;
  const staleRunIds = await agentSearchRunEventDb
    .findRunIdsWithEventsBefore(eventsCutoff, EVENT_SWEEP_BATCH)
    .catch(() => [] as string[]);
  if (staleRunIds.length > 0) {
    await agentSearchRunEventDb
      .deleteByRunIds(staleRunIds)
      .catch(() => undefined);
  }

  const orphanDirs = await cleanupOrphanWorkspaces();

  if (snapshots + expiredRuns.length + orphanDirs + staleRunIds.length > 0) {
    memoryLogger.info(
      `Agent search cleanup: ${snapshots} snapshot(s), ${expiredRuns.length} run(s), ${staleRunIds.length} event sweep(s), ${orphanDirs} orphan dir(s)`,
      'AgentSearch',
    );
  }
  return { snapshots, runs: expiredRuns.length, orphanDirs, eventsSwept: staleRunIds.length };
}

async function cleanupOrphanWorkspaces(): Promise<number> {
  const base = process.env.AGENT_WORKSPACE_DIR || path.join(process.cwd(), 'data', 'agent-workspaces');
  let entries;
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  for (const entry of entries) {
    const dir = path.join(base, entry);
    try {
      const info = await stat(dir);
      if (info.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // 单个目录失败不阻塞整体清理
    }
  }
  return removed;
}

export function startAgentSearchCleanup(): void {
  if (cleanupJob) return;
  // 滑动 TTL 下过期是常态而非异常，cron 频率直接决定磁盘回收滞后：
  // 每 30 分钟一次意味着过期后最多再占 30 分钟。
  cleanupJob = cron.schedule('*/5 * * * *', async () => {
    try {
      await runAgentSearchCleanup();
    } catch (e) {
      memoryLogger.error?.(`Agent search cleanup failed: ${e}`, 'AgentSearch');
    }
  });
}

export function stopAgentSearchCleanup(): void {
  cleanupJob?.stop();
  cleanupJob = null;
}
