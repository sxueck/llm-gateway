import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    connection,
    getConnection: vi.fn(async () => connection),
  };
});

vi.mock("../connection.js", () => ({
  getDatabase: () => ({ getConnection: mocks.getConnection }),
}));

import { agentRunMonitoringRepository } from "./agent-search.repository.js";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    plugin_id: "com.example.search",
    plugin_version: "1.0.0",
    source_type: "snapshot",
    model_profile: "default",
    status: "completed",
    created_at: 1000,
    started_at: 1100,
    completed_at: 1500,
    error_code: null,
    error_message: null,
    turn_count: 3,
    tool_call_count: 2,
    input_tokens: 100,
    output_tokens: 50,
    cost: "0.010000",
    ...overrides,
  };
}

describe("agentRunMonitoringRepository.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries only non-sensitive columns and maps items and summary", async () => {
    mocks.connection.query
      .mockResolvedValueOnce([[runRow()]])
      .mockResolvedValueOnce([
        [
          {
            total: 1,
            active: 0,
            queued: 0,
            running: 0,
            completed: 1,
            failed: 0,
            timed_out: 0,
            budget_exceeded: 0,
            input_tokens: 100,
            output_tokens: 50,
            cost: "0.010000",
            avg_duration_ms: 400,
            snapshot_runs: 1,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [{ total: 2, ready: 1, file_count: 30, total_size: 4096 }],
      ]);

    const result = await agentRunMonitoringRepository.list({
      status: "completed",
      activeOnly: undefined,
      limit: 50,
      offset: 0,
    });

    const listSql = mocks.connection.query.mock.calls[0][0] as string;
    expect(listSql).toContain("ORDER BY r.created_at DESC, r.id DESC");
    expect(listSql).toContain(
      "LEFT JOIN agent_search_usage u ON u.run_id = r.id",
    );
    for (const forbidden of [
      "query_encrypted",
      "result_encrypted",
      "service_token_hash",
      "public_git_url_encrypted",
      "model_route_metadata",
    ]) {
      expect(listSql).not.toContain(forbidden);
    }
    expect(mocks.connection.query.mock.calls[0][1]).toEqual([
      "completed",
      50,
      0,
    ]);

    expect(result.summary).toEqual({
      total: 1,
      active: 0,
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      timed_out: 0,
      budget_exceeded: 0,
      input_tokens: 100,
      output_tokens: 50,
      cost: 0.01,
      avg_duration_ms: 400,
      snapshot_runs: 1,
      snapshots: { total: 2, ready: 1, file_count: 30, total_size: 4096 },
    });
    const snapshotSql = mocks.connection.query.mock.calls[2][0] as string;
    expect(snapshotSql).toContain("FROM repository_snapshots");
    expect(snapshotSql).toContain("deleted_at IS NULL");
    expect(snapshotSql).not.toContain("agent_search_runs");
    expect(mocks.connection.query.mock.calls[2][1]).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: "run-1",
      plugin_id: "com.example.search",
      plugin_version: "1.0.0",
      source_type: "snapshot",
      model_profile: "default",
      status: "completed",
      created_at: 1000,
      started_at: 1100,
      completed_at: 1500,
      duration_ms: 400,
      error_code: null,
      error_message: null,
      usage: {
        turn_count: 3,
        tool_call_count: 2,
        input_tokens: 100,
        output_tokens: 50,
        cost: 0.01,
      },
    });
    expect(mocks.connection.release).toHaveBeenCalled();
  });

  it("derives null duration/usage for runs without usage rows and combines activeOnly filter", async () => {
    mocks.connection.query
      .mockResolvedValueOnce([
        [
          runRow({
            status: "running",
            started_at: 1100,
            completed_at: null,
            turn_count: null,
            tool_call_count: null,
            input_tokens: null,
            output_tokens: null,
            cost: null,
          }),
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            total: 1,
            active: 1,
            queued: 1,
            running: 0,
            completed: 0,
            failed: 0,
            timed_out: 0,
            budget_exceeded: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost: "0",
            avg_duration_ms: null,
            snapshot_runs: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [{ total: 0, ready: 0, file_count: 0, total_size: 0 }],
      ]);

    const result = await agentRunMonitoringRepository.list({
      status: undefined,
      activeOnly: true,
      limit: 100,
      offset: 25,
    });

    expect(
      (mocks.connection.query.mock.calls[0][0] as string).trim(),
    ).toContain("WHERE r.status IN ('queued', 'running')");
    expect(mocks.connection.query.mock.calls[0][1]).toEqual([100, 25]);
    expect(result.items[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.items[0].usage).toBeNull();
    expect(result.summary.avg_duration_ms).toBeNull();
    expect(result.summary.snapshots).toEqual({
      total: 0,
      ready: 0,
      file_count: 0,
      total_size: 0,
    });
  });
});
