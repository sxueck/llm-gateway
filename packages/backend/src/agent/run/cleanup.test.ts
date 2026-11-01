import { mkdtemp, mkdir, utimes, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunRow = { id: string; expires_at: number; status: string };
type EventRow = { run_id: string; created_at: number };

const state = vi.hoisted(() => ({
  runs: new Map<string, RunRow>(),
  events: [] as EventRow[],
  snapshotsRemoved: 0,
  snapshotRetentionMs: 24 * 60 * 60 * 1000,
  deleteShouldFail: false,
}));

vi.mock('../../db/index.js', () => ({
  agentSearchRunDb: {
    findExpired: async (now: number) =>
      [...state.runs.values()].filter(
        (run) => run.status !== 'expired' && run.expires_at <= now,
      ),
    markExpired: async (id: string) => {
      const run = state.runs.get(id);
      if (run) run.status = 'expired';
    },
  },
  agentSearchRunEventDb: {
    findRunIdsWithEventsBefore: async (cutoff: number, limit: number) => {
      const ids = [
        ...new Set(
          state.events
            .filter((event) => event.created_at < cutoff)
            .map((event) => event.run_id),
        ),
      ];
      return ids.slice(0, limit);
    },
    deleteByRunIds: async (runIds: string[]) => {
      if (state.deleteShouldFail) throw new Error('db gone');
      const doomed = new Set(runIds);
      state.events = state.events.filter((event) => !doomed.has(event.run_id));
    },
  },
}));

vi.mock('../../services/logger.js', () => ({
  memoryLogger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('../snapshot/snapshot.service.js', () => ({
  cleanupExpiredSnapshots: async () => {
    const n = state.snapshotsRemoved;
    state.snapshotsRemoved = 0;
    return n;
  },
  SNAPSHOT_RETENTION_MS: state.snapshotRetentionMs,
}));

import { runAgentSearchCleanup } from './cleanup.js';

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
let workspaceDir: string | undefined;
let previousWorkspaceDir: string | undefined;

function seedRun(id: string, expiresAt: number, status = 'completed') {
  state.runs.set(id, { id, expires_at: expiresAt, status });
}

function seedEvent(runId: string, createdAt: number) {
  state.events.push({ run_id: runId, created_at: createdAt });
}

beforeEach(async () => {
  state.runs.clear();
  state.events = [];
  state.snapshotsRemoved = 0;
  state.deleteShouldFail = false;
  previousWorkspaceDir = process.env.AGENT_WORKSPACE_DIR;
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'agent-cleanup-'));
  process.env.AGENT_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (previousWorkspaceDir === undefined) delete process.env.AGENT_WORKSPACE_DIR;
  else process.env.AGENT_WORKSPACE_DIR = previousWorkspaceDir;
});

describe('agent search cleanup retention outcomes', () => {
  it('marks expired runs but keeps their events inside the retention window', async () => {
    const now = Date.now();
    seedRun('asr_fresh', now - 1_000);
    seedEvent('asr_fresh', now - 60_000);

    const result = await runAgentSearchCleanup();

    expect(state.runs.get('asr_fresh')?.status).toBe('expired');
    expect(state.events).toEqual([{ run_id: 'asr_fresh', created_at: now - 60_000 }]);
    expect(result).toEqual({
      snapshots: 0,
      runs: 1,
      orphanDirs: 0,
      eventsSwept: 0,
    });
  });

  it('sweeps only events older than the retention cutoff and leaves fresher ones', async () => {
    const now = Date.now();
    seedRun('asr_old', now - SEVEN_DAYS - 60_000);
    seedRun('asr_kept', now - 60_000);
    seedEvent('asr_old', now - SEVEN_DAYS - 30_000);
    seedEvent('asr_kept', now - 60_000);

    const result = await runAgentSearchCleanup();

    expect(state.events.map((e) => e.run_id)).toEqual(['asr_kept']);
    expect(result.eventsSwept).toBe(1);
    expect(result.runs).toBe(2);
  });

  it('continues cleanup when event deletion fails, leaving events in place', async () => {
    const now = Date.now();
    seedRun('asr_old', now - SEVEN_DAYS - 60_000);
    seedEvent('asr_old', now - SEVEN_DAYS - 30_000);
    state.snapshotsRemoved = 2;
    state.deleteShouldFail = true;

    const result = await runAgentSearchCleanup();

    expect(result.snapshots).toBe(2);
    expect(result.eventsSwept).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  it('removes orphan workspace dirs past snapshot retention and keeps fresher ones', async () => {
    const staleDir = path.join(workspaceDir!, 'asr_stale');
    const freshDir = path.join(workspaceDir!, 'asr_fresh');
    await mkdir(staleDir);
    await mkdir(freshDir);
    await writeFile(path.join(staleDir, 'marker'), 'x');
    await writeFile(path.join(freshDir, 'marker'), 'y');

    const staleTime = (Date.now() - state.snapshotRetentionMs - 60_000) / 1000;
    await utimes(staleDir, staleTime, staleTime);

    const result = await runAgentSearchCleanup();

    expect(result.orphanDirs).toBe(1);
    await expect(access(staleDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(freshDir)).resolves.toBeUndefined();
  });
});
