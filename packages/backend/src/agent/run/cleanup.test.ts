import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findExpired: vi.fn(),
  markExpired: vi.fn(),
  findRunIdsWithEventsBefore: vi.fn(),
  deleteByRunIds: vi.fn(),
  cleanupExpiredSnapshots: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  agentSearchRunDb: {
    findExpired: mocks.findExpired,
    markExpired: mocks.markExpired,
  },
  agentSearchRunEventDb: {
    findRunIdsWithEventsBefore: mocks.findRunIdsWithEventsBefore,
    deleteByRunIds: mocks.deleteByRunIds,
  },
}));
vi.mock('../../services/logger.js', () => ({
  memoryLogger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('../snapshot/snapshot.service.js', () => ({
  cleanupExpiredSnapshots: mocks.cleanupExpiredSnapshots,
  SNAPSHOT_RETENTION_MS: 24 * 60 * 60 * 1000,
}));
vi.mock('fs/promises', () => ({
  readdir: mocks.readdir,
  rm: vi.fn(),
  stat: vi.fn(),
}));

import { runAgentSearchCleanup } from './cleanup.js';

describe('agent search cleanup retention', () => {
  beforeEach(() => {
    mocks.cleanupExpiredSnapshots.mockResolvedValue(0);
    mocks.findExpired.mockResolvedValue([]);
    mocks.markExpired.mockReset();
    mocks.findRunIdsWithEventsBefore.mockResolvedValue([]);
    mocks.deleteByRunIds.mockReset();
    mocks.deleteByRunIds.mockResolvedValue(undefined);
    mocks.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('marks expired runs but keeps their events inside the retention window', async () => {
    mocks.findExpired.mockResolvedValue([{ id: 'asr_fresh' }]);

    const result = await runAgentSearchCleanup();

    expect(mocks.markExpired).toHaveBeenCalledWith('asr_fresh');
    expect(mocks.deleteByRunIds).not.toHaveBeenCalled();
    expect(result).toEqual({
      snapshots: 0,
      runs: 1,
      orphanDirs: 0,
      eventsSwept: 0,
    });
  });

  it('sweeps events only for runs past the retention cutoff, batched', async () => {
    mocks.findRunIdsWithEventsBefore.mockResolvedValue([
      'asr_old_1',
      'asr_old_2',
    ]);

    const result = await runAgentSearchCleanup();

    expect(mocks.deleteByRunIds).toHaveBeenCalledWith([
      'asr_old_1',
      'asr_old_2',
    ]);
    expect(result.eventsSwept).toBe(2);
  });

  it('passes a cutoff shifted by the retention window (7d default)', async () => {
    const before = Date.now();
    await runAgentSearchCleanup();
    const after = Date.now();

    const calls = mocks.findRunIdsWithEventsBefore.mock.calls;
    const cutoff = calls[calls.length - 1][0] as number;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - sevenDays);
    expect(cutoff).toBeLessThanOrEqual(after - sevenDays);
  });

  it('tolerates event sweep failures without failing the whole cleanup', async () => {
    mocks.findRunIdsWithEventsBefore.mockResolvedValue(['asr_old_1']);
    mocks.deleteByRunIds.mockRejectedValue(new Error('db gone'));

    const result = await runAgentSearchCleanup();

    expect(result.eventsSwept).toBe(1);
  });
});
