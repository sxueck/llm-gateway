import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runs = new Map<string, any>();
  const usage = new Map<string, any>();
  const events: { runId: string; type: string }[] = [];
  const pluginRows = new Map<string, any>();
  return {
    runs,
    usage,
    events,
    pluginRows,
    agentSearchRunRepository: {
      create: vi.fn(async (r: any) => {
        runs.set(r.id, {
          ...r,
          started_at: null,
          completed_at: null,
          cancellation_requested_at: null,
          result_encrypted: null,
        });
        return runs.get(r.id);
      }),
      getById: vi.fn(async (id: string) => runs.get(id)),
      update: vi.fn(async (id: string, u: any) =>
        Object.assign(runs.get(id), u),
      ),
      requestCancellation: vi.fn(async (id: string) => {
        const run = runs.get(id);
        if (
          run.cancellation_requested_at ||
          !["queued", "running"].includes(run.status)
        )
          return false;
        run.cancellation_requested_at = Date.now();
        return true;
      }),
      findActiveAtBoot: vi.fn(async () =>
        [...runs.values()].filter((r: any) =>
          ["queued", "running"].includes(r.status),
        ),
      ),
      markExpired: vi.fn(),
      findByServiceTokenHash: vi.fn(),
      findExpired: vi.fn(async () => []),
    },
    agentSearchUsageRepository: {
      upsert: vi.fn(async (u: any) => usage.set(u.run_id, u)),
      getByRunId: vi.fn(async (id: string) => usage.get(id)),
    },
    agentSearchRunEventRepository: {
      append: vi.fn(async (runId: string, _seq: number, type: string) => {
        events.push({ runId, type });
      }),
      maxSeq: vi.fn(async () => 0),
      listAfter: vi.fn(async () => []),
      deleteByRunIds: vi.fn(),
    },
    snapshotRepository: {
      getById: vi.fn(),
      markReady: vi.fn(),
      markDeleted: vi.fn(),
      create: vi.fn(),
      findExpired: vi.fn(async () => []),
    },
    systemConfigRepository: { get: vi.fn(async () => undefined), set: vi.fn() },
    workerPluginRepository: {
      create: vi.fn(async (row: any) => {
        pluginRows.set(`${row.id}@${row.version}`, {
          bundle_url: null,
          signature: null,
          deprecated_at: null,
          revoked_at: null,
          ...row,
        });
        return pluginRows.get(`${row.id}@${row.version}`);
      }),
      getByIdVersion: vi.fn(async (id: string, version: string) =>
        pluginRows.get(`${id}@${version}`),
      ),
      listAll: vi.fn(async () => [...pluginRows.values()]),
      setStatus: vi.fn(async (id: string, version: string, status: string) => {
        const row = pluginRows.get(`${id}@${version}`);
        if (row) row.status = status;
        return row;
      }),
    },
  };
});

vi.mock("../../db/index.js", () => ({
  agentSearchRunDb: mocks.agentSearchRunRepository,
  agentSearchUsageDb: mocks.agentSearchUsageRepository,
  agentSearchRunEventDb: mocks.agentSearchRunEventRepository,
  repositorySnapshotDb: mocks.snapshotRepository,
  systemConfigDb: mocks.systemConfigRepository,
  workerPluginDb: mocks.workerPluginRepository,
  modelDb: {
    getByName: vi.fn(async () => ({ id: "m1", name: "search-fast" })),
  },
  getDatabase: () => ({
    getConnection: async () => {
      throw new Error("not needed");
    },
  }),
}));
vi.mock("../../services/logger.js", () => ({
  memoryLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../snapshot/snapshot.service.js", () => ({
  SNAPSHOT_RETENTION_MS: 86_400_000,
  getOwnedSnapshot: vi.fn(async () => ({
    id: "snap_1",
    status: "ready",
    expires_at: Date.now() + 3_600_000,
    virtual_key_id: "vk-1",
  })),
  buildWorkspace: vi.fn(async () => undefined),
}));
vi.mock("../snapshot/encryption.js", () => ({
  getMasterKey: async () => Buffer.alloc(32),
  encryptText: (_k: Buffer, t: string) => `ENC:${t}`,
  decryptText: (_k: Buffer, c: string) => c.slice(4),
}));

import {
  SearchRunScheduler,
  type RunExecutor,
  type ExecutorHandle,
} from "./scheduler.js";
import { agentSearchRunDb } from "../../db/index.js";
import { seedBuiltinPlugins } from "../plugins/store.js";
import { CODE_SEARCH_MANIFEST } from "../plugins/code-search.js";

let workspaceBase: string;

class FakeExecutor implements RunExecutor {
  readonly name = "fake";
  lastEnv: Record<string, string> | null = null;
  exitedResolvers: ((v: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void)[] = [];
  killCalls = 0;

  async start(ctx: { env: Record<string, string> }): Promise<ExecutorHandle> {
    this.lastEnv = ctx.env;
    return {
      exited: new Promise((resolve) => this.exitedResolvers.push(resolve)),
      kill: async () => {
        this.killCalls++;
        this.exitedResolvers.forEach((r) =>
          r({ code: null, signal: "SIGKILL" }),
        );
      },
    };
  }
}

function validResult(runId: string) {
  return {
    run_id: runId,
    status: "completed",
    repository: { source_type: "snapshot", snapshot_id: "snap_1" },
    summary: "Found the refresh flow.",
    files: [
      {
        path: "src/auth/refresh.ts",
        start_line: 1,
        end_line: 5,
        reason: "refresh entry",
      },
    ],
    uncertainties: [],
    next_questions: [],
    usage: {
      plugin: `com.llm-gateway.code-search@${CODE_SEARCH_MANIFEST.version}`,
      model_profile: "search-fast",
      turns: 1,
      tool_calls: 1,
      input_tokens: 10,
      output_tokens: 20,
      cost: 0.001,
    },
  };
}

async function seedRun(id: string) {
  await agentSearchRunDb.create({
    id,
    user_id: "vk-1",
    virtual_key_id: "vk-1",
    plugin_id: "com.llm-gateway.code-search",
    plugin_version: CODE_SEARCH_MANIFEST.version,
    plugin_digest: "sha256:x",
    source_type: "snapshot",
    snapshot_id: "snap_1",
    public_git_url_encrypted: null,
    requested_ref: null,
    resolved_commit: null,
    query_encrypted: "ENC:find refresh flow",
    model_profile: "search-fast",
    status: "queued",
    error_code: null,
    error_message: null,
    service_token_hash: "hash",
    created_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  workspaceBase = await mkdtemp(path.join(tmpdir(), "agent-ws-"));
  process.env.AGENT_WORKSPACE_DIR = workspaceBase;
  mocks.runs.clear();
  mocks.usage.clear();
  mocks.events.length = 0;
  mocks.pluginRows.clear();
  mocks.agentSearchRunRepository.getById.mockImplementation(async (id: string) =>
    mocks.runs.get(id),
  );
  // scheduler 通过 store 解析插件（DB 化注册表），用真实 seed 填充内存 mock
  await seedBuiltinPlugins();
});

afterEach(async () => {
  delete process.env.AGENT_WORKSPACE_DIR;
  delete process.env.AGENT_SEARCH_TIMEOUT_MARGIN_MS;
  delete process.env.AGENT_SEARCH_TIMEOUT_MS;
  delete process.env.AGENT_SEARCH_CONCURRENCY;
  delete process.env.AGENT_WORKER_GATEWAY_URL;
  await rm(workspaceBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("SearchRunScheduler", () => {
  it("runs a run to completion on terminal report and cleans the workspace", async () => {
    const scheduler = new SearchRunScheduler();
    const executor = new FakeExecutor();
    scheduler.setExecutor(executor);
    await seedRun("asr_ok");
    scheduler.registerServiceToken("asr_ok", "tok123");
    process.env.AGENT_WORKER_GATEWAY_URL = "http://gw.test:9";
    scheduler.enqueue("asr_ok");

    await waitFor(() => mocks.runs.get("asr_ok").status === "running");
    expect(executor.lastEnv?.AGENT_SERVICE_TOKEN).toBe("tok123");
    expect(executor.lastEnv?.AGENT_RUN_ID).toBe("asr_ok");
    expect(executor.lastEnv?.AGENT_GATEWAY_INTERNAL_URL).toBe(
      "http://gw.test:9",
    );

    scheduler.reportTerminal("asr_ok", {
      kind: "completed",
      result: validResult("asr_ok"),
      usage: {
        turns: 1,
        tool_calls: 1,
        input_tokens: 10,
        output_tokens: 20,
        cost: 0.001,
      },
    });

    await waitFor(() => mocks.runs.get("asr_ok").status === "completed");
    const run = mocks.runs.get("asr_ok");
    expect(run.result_encrypted).toContain("Found the refresh flow.");
    expect(mocks.usage.get("asr_ok").tool_call_count).toBe(1);
    expect(mocks.events.map((e) => e.type)).toContain("run.completed");
    // workspace 清理
    await expect(stat(path.join(workspaceBase, "asr_ok"))).rejects.toBeTruthy();
  });

  it("enriches a model-shaped result with gateway-side repository/usage before storing", async () => {
    const scheduler = new SearchRunScheduler();
    scheduler.setExecutor(new FakeExecutor());
    await seedRun("asr_seam");
    // internal 计量链路先行写入 token 用量（唯一权威）
    await mocks.agentSearchUsageRepository.upsert({
      run_id: "asr_seam",
      turn_count: 0,
      tool_call_count: 0,
      input_tokens: 111,
      output_tokens: 222,
      cost: 0.5,
      model_route_metadata: null,
      updated_at: Date.now(),
    });
    scheduler.registerServiceToken("asr_seam", "tok");
    scheduler.enqueue("asr_seam");
    await waitFor(() => mocks.runs.get("asr_seam").status === "running");

    scheduler.reportTerminal("asr_seam", {
      kind: "completed",
      result: {
        status: "completed",
        summary: "Found it.",
        files: [
          {
            path: "src/a.ts",
            start_line: 1,
            end_line: 2,
            reason: "refresh entry",
          },
        ],
      },
      usage: {
        turns: 2,
        tool_calls: 3,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
      },
    });

    await waitFor(() => mocks.runs.get("asr_seam").status === "completed");
    const stored = JSON.parse(
      (mocks.runs.get("asr_seam").result_encrypted as string).slice(4),
    );
    expect(stored.run_id).toBe("asr_seam");
    expect(stored.repository).toEqual({
      source_type: "snapshot",
      snapshot_id: "snap_1",
      commit: null,
    });
    expect(stored.usage).toEqual({
      plugin: `com.llm-gateway.code-search@${CODE_SEARCH_MANIFEST.version}`,
      model_profile: "search-fast",
      turns: 2,
      tool_calls: 3,
      input_tokens: 111,
      output_tokens: 222,
      cost: 0.5,
    });
  });

  it("caps concurrent starts and drains the queue as slots free", async () => {
    process.env.AGENT_SEARCH_CONCURRENCY = "2";
    try {
      const scheduler = new SearchRunScheduler();
      const executor = new FakeExecutor();
      scheduler.setExecutor(executor);
      for (const id of ["asr_c1", "asr_c2", "asr_c3", "asr_c4"])
        await seedRun(id);
      for (const id of ["asr_c1", "asr_c2", "asr_c3", "asr_c4"])
        scheduler.enqueue(id);

      await waitFor(() => mocks.runs.get("asr_c1").status === "running");
      await waitFor(() => mocks.runs.get("asr_c2").status === "running");
      await new Promise((r) => setTimeout(r, 100));
      expect(mocks.runs.get("asr_c3").status).toBe("queued");
      expect(mocks.runs.get("asr_c4").status).toBe("queued");
      expect(executor.exitedResolvers.length).toBe(2);

      scheduler.reportTerminal("asr_c1", {
        kind: "completed",
        result: validResult("asr_c1"),
        usage: {
          turns: 1,
          tool_calls: 0,
          input_tokens: 1,
          output_tokens: 1,
          cost: 0,
        },
      });
      await waitFor(() => mocks.runs.get("asr_c3").status === "running");
      expect(mocks.runs.get("asr_c4").status).toBe("queued");
    } finally {
      delete process.env.AGENT_SEARCH_CONCURRENCY;
    }
  });

  it("rejects an invalid structured result instead of storing it", async () => {
    const scheduler = new SearchRunScheduler();
    scheduler.setExecutor(new FakeExecutor());
    await seedRun("asr_bad");
    scheduler.enqueue("asr_bad");
    await waitFor(() => mocks.runs.get("asr_bad").status === "running");

    scheduler.reportTerminal("asr_bad", {
      kind: "completed",
      result: { summary: "no required fields" },
      usage: {
        turns: 1,
        tool_calls: 0,
        input_tokens: 1,
        output_tokens: 1,
        cost: 0,
      },
    });
    await waitFor(() => mocks.runs.get("asr_bad").status === "failed");
    expect(mocks.runs.get("asr_bad").error_code).toBe(
      "output_validation_failed",
    );
    expect(mocks.runs.get("asr_bad").result_encrypted).toBeNull();
  });

  it("marks a run timed_out when the budget clock expires", async () => {
    process.env.AGENT_SEARCH_TIMEOUT_MS = "50";
    const scheduler = new SearchRunScheduler();
    const executor = new FakeExecutor();
    scheduler.setExecutor(executor);
    await seedRun("asr_to");
    scheduler.enqueue("asr_to");
    await waitFor(() => mocks.runs.get("asr_to").status === "timed_out");
    expect(executor.killCalls).toBeGreaterThan(0);
  });

  it("fails a run when the worker exits without a terminal report", async () => {
    const scheduler = new SearchRunScheduler();
    const executor = new FakeExecutor();
    scheduler.setExecutor(executor);
    await seedRun("asr_crash");
    scheduler.enqueue("asr_crash");
    await waitFor(() => mocks.runs.get("asr_crash").status === "running");
    executor.exitedResolvers.forEach((r) => r({ code: 1, signal: null }));
    await waitFor(() => mocks.runs.get("asr_crash").status === "failed");
    expect(mocks.runs.get("asr_crash").error_code).toBe(
      "worker_exited_without_result",
    );
  });

  it("cancel is idempotent: only the first request kills the worker", async () => {
    const scheduler = new SearchRunScheduler();
    const executor = new FakeExecutor();
    scheduler.setExecutor(executor);
    await seedRun("asr_cancel");
    scheduler.enqueue("asr_cancel");
    await waitFor(() => mocks.runs.get("asr_cancel").status === "running");

    const first =
      await mocks.agentSearchRunRepository.requestCancellation("asr_cancel");
    const second =
      await mocks.agentSearchRunRepository.requestCancellation("asr_cancel");
    expect(first).toBe(true);
    expect(second).toBe(false);
    if (first) scheduler.requestKill("asr_cancel");

    await waitFor(() => mocks.runs.get("asr_cancel").status === "cancelled");
    expect(executor.killCalls).toBe(1);
  });

  it("cancels a queued run before it starts", async () => {
    const scheduler = new SearchRunScheduler();
    scheduler.setExecutor(new FakeExecutor());
    await seedRun("asr_q");
    await mocks.agentSearchRunRepository.requestCancellation("asr_q");
    scheduler.enqueue("asr_q");
    await waitFor(() => mocks.runs.get("asr_q").status === "cancelled");
    expect(mocks.runs.get("asr_q").error_code).toBe("cancelled_before_start");
  });

  it("does not start a worker when cancellation lands during scheduler startup", async () => {
    const scheduler = new SearchRunScheduler();
    const executor = new FakeExecutor();
    scheduler.setExecutor(executor);
    await seedRun("asr_start_race");
    let reads = 0;
    mocks.agentSearchRunRepository.getById.mockImplementation(async (id: string) => {
      reads++;
      if (reads === 2) {
        mocks.runs.get(id).cancellation_requested_at = Date.now();
      }
      return mocks.runs.get(id);
    });

    scheduler.enqueue("asr_start_race");

    await waitFor(
      () => mocks.runs.get("asr_start_race").status === "cancelled",
    );
    expect(executor.lastEnv).toBeNull();
    expect(mocks.runs.get("asr_start_race").error_code).toBe(
      "cancelled_before_start",
    );
  });

  it("recoverAtBoot deterministically fails active runs", async () => {
    const scheduler = new SearchRunScheduler();
    await seedRun("asr_boot");
    const failed = await scheduler.recoverAtBoot();
    expect(failed).toBe(1);
    expect(mocks.runs.get("asr_boot").status).toBe("failed");
    expect(mocks.runs.get("asr_boot").error_code).toBe("gateway_restarted");
  });

  it("fails deterministically when no executor is configured", async () => {
    const scheduler = new SearchRunScheduler();
    await seedRun("asr_noexec");
    scheduler.enqueue("asr_noexec");
    await waitFor(() => mocks.runs.get("asr_noexec").status === "failed");
    expect(mocks.runs.get("asr_noexec").error_code).toBe(
      "executor_not_configured",
    );
  });
});
