import { beforeEach, describe, expect, it, vi } from 'vitest';

// AGENT_SNAPSHOT_MASTER_KEY：让 getMasterKey 走 env 分支，不触 systemConfigDb（被 mock 掉）。
process.env.AGENT_SNAPSHOT_MASTER_KEY ||= '0123456789abcdef'.repeat(4);

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  modelDb: { getByName: vi.fn(async () => ({ id: 1 })) },
  agentSearchRunDb: { create: mocks.create },
  agentSearchUsageDb: {},
  repositorySnapshotDb: {},
  systemConfigDb: {},
  userPluginEnrollmentDb: {},
  workerPluginDb: {},
}));

import { persistNewRun, validateRunInputs } from './run.service.js';

const PLUGIN = {
  manifest: {
    id: 'com.llm-gateway.code-search',
    version: '1.0.6',
    model_policy: { profile: 'search-fast', allow_client_override: false },
  },
  digest: 'sha256:' + 'a'.repeat(64),
  files: {},
};

const BODY = {
  plugin: { id: 'com.llm-gateway.code-search', version: 'latest' },
  source: { type: 'snapshot', snapshot_id: 'snap_1' },
  query: 'find the retry path',
  options: {},
} as const;

describe('persistNewRun resolved_commit', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockImplementation(async (row: unknown) => row);
  });

  it('records the snapshot head_commit as resolved_commit', async () => {
    const { run } = await persistNewRun({
      principal: { virtualKeyId: 'vk-1' },
      body: BODY,
      plugin: PLUGIN,
      profile: 'search-fast',
      resolvedCommit: 'deadbeef',
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const row = mocks.create.mock.calls[0][0];
    expect(row.resolved_commit).toBe('deadbeef');
    expect(row.snapshot_id).toBe('snap_1');
    expect(run.resolved_commit).toBe('deadbeef');
  });

  it('keeps resolved_commit null when the snapshot carries no head_commit', async () => {
    await persistNewRun({
      principal: { virtualKeyId: 'vk-1' },
      body: BODY,
      plugin: PLUGIN,
      profile: 'search-fast',
      resolvedCommit: null,
    });

    expect(mocks.create.mock.calls[0][0].resolved_commit).toBeNull();
  });
});

describe('validateRunInputs resolvedCommit', () => {
  vi.mock('../plugins/store.js', () => ({
    PluginStoreError: class extends Error {},
    resolvePlugin: vi.fn(async () => PLUGIN),
  }));
  vi.mock('../snapshot/snapshot.service.js', () => ({
    buildWorkspace: vi.fn(),
    getOwnedSnapshot: vi.fn(async () => ({
      id: 'snap_1',
      status: 'ready',
      expires_at: Date.now() + 60_000,
      head_commit: 'cafebabe',
    })),
    touchSnapshot: vi.fn(),
    SNAPSHOT_RETENTION_MS: 24 * 60 * 60 * 1000,
  }));

  it('returns the owned snapshot head_commit as resolvedCommit', async () => {
    const { resolvedCommit } = await validateRunInputs({ virtualKeyId: 'vk-1' }, BODY);
    expect(resolvedCommit).toBe('cafebabe');
  });
});
