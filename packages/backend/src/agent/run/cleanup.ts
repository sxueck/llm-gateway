import * as cron from 'node-cron';
import { readdir, rm, stat } from 'fs/promises';
import path from 'path';
import { agentSearchRunDb, agentSearchRunEventDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { cleanupExpiredSnapshots } from '../snapshot/snapshot.service.js';
import { SNAPSHOT_RETENTION_MS } from '../snapshot/snapshot.service.js';

let cleanupJob: cron.ScheduledTask | null = null;

export async function runAgentSearchCleanup(): Promise<{ snapshots: number; runs: number; orphanDirs: number }> {
  const snapshots = await cleanupExpiredSnapshots();

  const expiredRuns = await agentSearchRunDb.findExpired(Date.now());
  for (const run of expiredRuns) {
    await agentSearchRunDb.markExpired(run.id);
    await agentSearchRunEventDb.deleteByRunIds([run.id]).catch(() => undefined);
  }

  const orphanDirs = await cleanupOrphanWorkspaces();

  if (snapshots + expiredRuns.length + orphanDirs > 0) {
    memoryLogger.info(
      `Agent search cleanup: ${snapshots} snapshot(s), ${expiredRuns.length} run(s), ${orphanDirs} orphan dir(s)`,
      'AgentSearch',
    );
  }
  return { snapshots, runs: expiredRuns.length, orphanDirs };
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
