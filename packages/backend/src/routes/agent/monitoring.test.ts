import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  getUsage: vi.fn(),
  listEvents: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  agentSearchRunDb: { getById: mocks.getRunById },
}));
vi.mock('../../agent/run/run-events.js', () => ({
  runEventHub: { openStream: mocks.openStream },
}));;
vi.mock('../../db/repositories/agent-search.repository.js', () => ({
  agentRunMonitoringRepository: { list: vi.fn() },
  agentSearchRunEventRepository: { listAfter: mocks.listEvents },
  agentSearchUsageRepository: { getByRunId: mocks.getUsage },
}));

import { agentMonitoringRoutes } from './monitoring.js';

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asr_1',
    user_id: 7,
    virtual_key_id: 3,
    plugin_id: 'code-search',
    plugin_version: '1.0.5',
    plugin_digest: 'dgest',
    source_type: 'snapshot',
    snapshot_id: 'snap_1',
    public_git_url_encrypted: 'ENC',
    requested_ref: 'main',
    resolved_commit: 'abc1234',
    query_encrypted: 'ENC-QUERY',
    model_profile: 'search-fast',
    status: 'completed',
    result_encrypted: 'ENC-RESULT',
    error_code: null,
    error_message: null,
    service_token_hash: 'HASH',
    created_at: 1700000000000,
    started_at: 1700000001000,
    completed_at: 1700000010000,
    expires_at: 1700086400000,
    cancellation_requested_at: null,
    ...overrides,
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorate('authenticate', async () => {});
  await agentMonitoringRoutes(app);
  return app;
}

describe('admin agent run detail', () => {
  beforeEach(() => {
    mocks.getUsage.mockResolvedValue({
      run_id: 'asr_1',
      turn_count: 2,
      tool_call_count: 4,
      input_tokens: 1000,
      output_tokens: 200,
      cost: '0.0123',
      model_route_metadata: null,
      updated_at: 1700000010000,
    });
    mocks.listEvents.mockResolvedValue([
      {
        id: 1,
        run_id: 'asr_1',
        seq: 1,
        type: 'run.queued',
        payload_json: '{"plugin":"code-search@1.0.5"}',
        created_at: 1700000000000,
      },
      {
        id: 2,
        run_id: 'asr_1',
        seq: 2,
        type: 'model.completed',
        payload_json: null,
        created_at: 1700000005000,
      },
    ]);
  });

  it('returns run detail with parsed events and usage aggregates', async () => {
    mocks.getRunById.mockResolvedValue(makeRun());
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_1' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run).toMatchObject({
      id: 'asr_1',
      status: 'completed',
      plugin: { id: 'code-search', version: '1.0.5' },
      source: { type: 'snapshot', commit: 'abc1234' },
      duration_ms: 9000,
      usage: { turn_count: 2, cost: 0.0123 },
    });
    expect(body.events).toEqual([
      {
        seq: 1,
        type: 'run.queued',
        payload: { plugin: 'code-search@1.0.5' },
        created_at: 1700000000000,
      },
      {
        seq: 2,
        type: 'model.completed',
        payload: {},
        created_at: 1700000005000,
      },
    ]);
    expect(body.events_truncated).toBe(false);
    await app.close();
  });

  it('never leaks encrypted fields, service token, or query/result ciphertext', async () => {
    mocks.getRunById.mockResolvedValue(makeRun());
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_1' });
    const text = JSON.stringify(response.json());

    for (const secret of [
      'query_encrypted',
      'result_encrypted',
      'public_git_url_encrypted',
      'service_token_hash',
      'ENC-QUERY',
      'ENC-RESULT',
      'HASH',
    ]) {
      expect(text).not.toContain(secret);
    }
    await app.close();
  });

  it('maps malformed payload json into _raw instead of throwing', async () => {
    mocks.getRunById.mockResolvedValue(makeRun());
    mocks.listEvents.mockResolvedValue([
      {
        id: 3,
        run_id: 'asr_1',
        seq: 3,
        type: 'run.completed',
        payload_json: '{not-json',
        created_at: 1700000010000,
      },
    ]);
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_1' });

    expect(response.statusCode).toBe(200);
    expect(response.json().events[0].payload).toEqual({
      _raw: '{not-json',
    });
    await app.close();
  });

  it('returns 404 for an unknown run id', async () => {
    mocks.getRunById.mockResolvedValue(undefined);
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
    await app.close();
  });

  it('flags truncated event replay at the cap', async () => {
    mocks.getRunById.mockResolvedValue(makeRun());
    mocks.listEvents.mockResolvedValue(
      Array.from({ length: 2000 }, (_, i) => ({
        id: i + 1,
        run_id: 'asr_1',
        seq: i + 1,
        type: 'run.queued',
        payload_json: null,
        created_at: 1700000000000 + i,
      })),
    );
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_1' });

    expect(response.json().events_truncated).toBe(true);
    await app.close();
  });

  it('streams run events as SSE and closes after replay for terminal runs', async () => {
    mocks.getRunById.mockResolvedValue(makeRun());
    mocks.openStream.mockImplementation((_runId, _after, onEvent) => {
      onEvent({
        seq: 1,
        type: 'run.completed',
        payload: { status: 'completed' },
        created_at: 1700000010000,
      });
      return {
        unsubscribe: vi.fn(),
        done: Promise.resolve(true),
      };
    });
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_1/events' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain(': connected');
    expect(response.body).toContain('event: run.completed');
    expect(response.body).toContain('"seq":1');
    await app.close();
  });

  it('returns 404 from the events stream for an unknown run', async () => {
    mocks.getRunById.mockResolvedValue(undefined);
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/asr_missing/events' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
