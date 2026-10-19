import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestCancellation: vi.fn(),
  getById: vi.fn(),
  requestKill: vi.fn(),
  append: vi.fn(),
}));

vi.mock('../proxy/auth.js', () => ({
  authenticateVirtualKey: vi.fn(async () => ({
    virtualKey: { id: 'vk-1' },
  })),
  extractVirtualKeyAuthHeader: vi.fn(() => 'key'),
}));
vi.mock('../../db/index.js', () => ({
  agentSearchRunDb: {
    requestCancellation: mocks.requestCancellation,
    getById: mocks.getById,
  },
}));
vi.mock('../../agent/run/run.service.js', () => ({
  RunError: class RunError extends Error {},
  getOwnedRun: vi.fn(async () => ({ id: 'asr_1', status: 'running' })),
  getRunUsage: vi.fn(),
  persistNewRun: vi.fn(),
  readRunResult: vi.fn(),
  validateRunInputs: vi.fn(),
}));
vi.mock('../../agent/run/run-events.js', () => ({
  runEventHub: { append: mocks.append, openStream: vi.fn() },
}));
vi.mock('../../agent/run/scheduler.js', () => ({
  searchRunScheduler: {
    queueDepth: vi.fn(),
    registerServiceToken: vi.fn(),
    enqueue: vi.fn(),
    requestKill: mocks.requestKill,
  },
}));

import { agentSearchRoutes } from './searches.js';
import { persistNewRun, validateRunInputs } from '../../agent/run/run.service.js';

describe('agent search run creation', () => {
  it('passes the snapshot-resolved commit from validateRunInputs into persistNewRun', async () => {
    vi.mocked(validateRunInputs).mockResolvedValue({
      plugin: { manifest: { id: 'com.llm-gateway.code-search', version: '1.0.6' }, digest: 'sha256:' + 'a'.repeat(64) },
      profile: 'search-fast',
      resolvedCommit: 'deadbeef',
    } as never);
    vi.mocked(persistNewRun).mockResolvedValue({
      run: { id: 'asr_2', status: 'queued', expires_at: 1 },
      serviceToken: 'st',
      query: 'q',
    } as never);

    const app = Fastify();
    await agentSearchRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      payload: {
        plugin: { id: 'com.llm-gateway.code-search', version: '1.0.6' },
        source: { type: 'snapshot', snapshot_id: 'snap_1' },
        query: 'trace the auth path',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(persistNewRun).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedCommit: 'deadbeef' }),
    );
    await app.close();
  });
});

describe('agent search cancellation', () => {
  beforeEach(() => {
    mocks.requestCancellation.mockResolvedValue(true);
    mocks.getById.mockResolvedValue({ id: 'asr_1', status: 'running' });
    mocks.requestKill.mockReset();
    mocks.append.mockReset();
  });

  it('does not emit a terminal event before the scheduler finalizes cancellation', async () => {
    const app = Fastify();
    await agentSearchRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/asr_1/cancel',
      headers: { authorization: 'Bearer key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run_id: 'asr_1',
      status: 'running',
      cancelled: false,
    });
    expect(mocks.requestKill).toHaveBeenCalledWith('asr_1');
    expect(mocks.append).not.toHaveBeenCalled();
    await app.close();
  });
});
