import { beforeEach, describe, expect, test, vi } from "vitest";

// Shared mutable mock connection. The service under test imports
// `getDatabase` from '../connection.js'; each test installs its own
// connection with a `query` implementation.
const connectionMock = vi.hoisted(() => {
  let current: any = null;
  return {
    getDatabase: () => ({ getConnection: async () => current }),
    setQuery: (handler: (sql: string, params?: any[]) => [any, any?]) => {
      current = {
        query: vi.fn(async (sql: string, params?: any[]) => handler(sql, params)),
        release: vi.fn(() => {}),
      };
    },
    currentConnection: () => current,
  };
});

vi.mock("../db/connection.js", () => ({ getDatabase: connectionMock.getDatabase }));

const repoMock = vi.hoisted(() => ({
  cleanupExpired: vi.fn(async (): Promise<number> => 0),
  cleanupExpiredBindings: vi.fn(async (): Promise<number> => 0),
  cleanupOldSwitchEvents: vi.fn(async (): Promise<number> => 0),
  configGet: vi.fn(async (): Promise<any> => undefined),
  configSet: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("../db/index.js", () => ({
  expertRoutingSessionBindingDb: { cleanupExpired: repoMock.cleanupExpired },
  contextNormalizationDb: {
    cleanupExpiredBindings: repoMock.cleanupExpiredBindings,
    cleanupOldSwitchEvents: repoMock.cleanupOldSwitchEvents,
  },
  systemConfigDb: { get: repoMock.configGet, set: repoMock.configSet },
}));

import {
  DEFAULT_RETENTION_DAYS,
  buildPurgePlans,
  getMaintenanceSettings,
  isValidPurgeTarget,
  listPurgeTargets,
  normalizeSettings,
  optimizeTables,
  resolveCutoff,
  runPurge,
  saveMaintenanceSettings,
} from "./db-maintenance-service.js";

const NOW = 1_700_000_000_000;

function mockSelect(rows: any[]) {
  connectionMock.setQuery(() => [rows]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("normalizeSettings", () => {
  test("clamps retention days to the allowed range", () => {
    const settings = normalizeSettings({
      retentionDays: { api_requests: 0, expert_routing_logs: 99_999, circuit_breaker_events: 30.9 },
    });
    expect(settings.retentionDays).toEqual({
      api_requests: 1,
      expert_routing_logs: 3650,
      circuit_breaker_events: 30,
    });
  });

  test("drops unknown tables and non-numeric values", () => {
    const settings = normalizeSettings({
      retentionDays: { prompt_samples: 5, api_requests: "soon" },
    });
    expect(settings.retentionDays).toEqual({});
  });
});

describe("purge targets", () => {
  test("allowlist only contains purgeable tables", () => {
    expect(isValidPurgeTarget("api_requests")).toBe(true);
    expect(isValidPurgeTarget("expert_routing_session_bindings")).toBe(true);
    expect(isValidPurgeTarget("prompt_samples")).toBe(false);
    expect(isValidPurgeTarget("users")).toBe(false);
  });

  test("listPurgeTargets covers every dispatch branch", () => {
    for (const target of listPurgeTargets()) {
      expect(isValidPurgeTarget(target)).toBe(true);
    }
  });

  test("resolveCutoff falls back to the default retention window", () => {
    expect(resolveCutoff("expert_routing_logs", { retentionDays: {} }, NOW)).toBe(
      NOW - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});

describe("buildPurgePlans", () => {
  test("counts age-purgeable rows at the resolved cutoff", async () => {
    mockSelect([{ total: 42 }]);
    const plans = await buildPurgePlans(["api_requests"], { retentionDays: { api_requests: 7 } }, NOW);
    expect(plans).toEqual([
      { table: "api_requests", mode: "age", cutoffAt: NOW - 7 * 24 * 60 * 60 * 1000, estimatedRows: 42 },
    ]);
    const [sql, params] = connectionMock.currentConnection().query.mock.calls[0];
    expect(sql).toContain("COUNT(*)");
    expect(params).toEqual(["api_requests", "created_at", NOW - 7 * 24 * 60 * 60 * 1000]);
  });

  test("counts expired bindings with the expiry predicate", async () => {
    mockSelect([{ total: 5 }]);
    const plans = await buildPurgePlans(["session_context_bindings"], { retentionDays: {} }, NOW);
    expect(plans).toEqual([
      { table: "session_context_bindings", mode: "expired", cutoffAt: NOW, estimatedRows: 5 },
    ]);
    const [, params] = connectionMock.currentConnection().query.mock.calls[0];
    expect(params).toEqual(["session_context_bindings", NOW, NOW]);
  });

  test("rejects unknown targets", async () => {
    await expect(buildPurgePlans(["virtual_keys"], { retentionDays: {} }, NOW)).rejects.toThrow(
      /unknown purge target/,
    );
  });
});

describe("runPurge", () => {
  test("batch-deletes age targets until a partial batch", async () => {
    let call = 0;
    connectionMock.setQuery(() => {
      call += 1;
      return [{ affectedRows: call < 3 ? 3 : 1 }];
    });
    const results = await runPurge(["circuit_breaker_events"], { retentionDays: {} }, 3, NOW);
    expect(results).toEqual([{ table: "circuit_breaker_events", deleted: 7, batches: 3 }]);
    const queries = connectionMock.currentConnection().query.mock.calls as [string, any[]][];
    expect(queries).toHaveLength(3);
    expect(queries[0][0]).toContain("DELETE FROM");
    expect(queries[0][1]).toEqual([
      "circuit_breaker_events",
      "triggered_at",
      NOW - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      3,
    ]);
  });

  test("delegates expired bindings to the repository batch cleanup", async () => {
    repoMock.cleanupExpired.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const results = await runPurge(["expert_routing_session_bindings"], { retentionDays: {} }, 2, NOW);
    expect(results).toEqual([{ table: "expert_routing_session_bindings", deleted: 3, batches: 2 }]);
    expect(repoMock.cleanupExpired).toHaveBeenNthCalledWith(1, NOW, 2);
    expect(repoMock.cleanupExpired).toHaveBeenNthCalledWith(2, NOW, 2);
  });

  test("purges switch events through the repository with a retention window", async () => {
    repoMock.cleanupOldSwitchEvents.mockResolvedValue(0);
    const results = await runPurge(["context_switch_events"], { retentionDays: { context_switch_events: 30 } }, 5, NOW);
    expect(results).toEqual([{ table: "context_switch_events", deleted: 0, batches: 1 }]);
    expect(repoMock.cleanupOldSwitchEvents).toHaveBeenCalledWith(NOW, 30 * 24 * 60 * 60 * 1000, 5);
  });

  test("rejects unknown targets", async () => {
    await expect(runPurge(["models"], { retentionDays: {} }, 10, NOW)).rejects.toThrow(
      /unknown purge target/,
    );
  });
});

describe("optimizeTables", () => {
  test("reports missing tables without executing SQL", async () => {
    mockSelect([{ total: 0 }]);
    const results = await optimizeTables(["no_such_table"]);
    expect(results).toEqual([{ table: "no_such_table", ok: false, messages: ["table not found"] }]);
  });

  test("optimizes an existing table and maps the result rows", async () => {
    connectionMock.setQuery((sql) =>
      sql.includes("information_schema")
        ? [[{ total: 1 }]]
        : [[{ Msg_type: "note", Msg_text: "Table does not support optimize, doing recreate + analyze instead" }, { Msg_type: "status", Msg_text: "OK" }]],
    );
    const results = await optimizeTables(["api_requests"]);
    expect(results).toEqual([
      {
        table: "api_requests",
        ok: true,
        messages: [
          "note: Table does not support optimize, doing recreate + analyze instead",
          "status: OK",
        ],
      },
    ]);
    const optimizeCall = (connectionMock.currentConnection().query.mock.calls as [string, any[]][]).find(
      ([sql]) => sql.includes("OPTIMIZE TABLE"),
    );
    expect(optimizeCall?.[0]).toContain("OPTIMIZE TABLE ??");
    expect(optimizeCall?.[1]).toEqual(["api_requests"]);
  });
});

describe("settings persistence", () => {
  test("reads and normalizes the stored JSON", async () => {
    repoMock.configGet.mockResolvedValue({ value: JSON.stringify({ retentionDays: { api_requests: 14 } }) });
    const settings = await getMaintenanceSettings();
    expect(settings.retentionDays).toEqual({ api_requests: 14 });
  });

  test("falls back to defaults on unparsable storage", async () => {
    repoMock.configGet.mockResolvedValue({ value: "{broken" });
    expect(await getMaintenanceSettings()).toEqual({ retentionDays: {} });
  });

  test("saves the normalized settings payload", async () => {
    await saveMaintenanceSettings({ retentionDays: { api_requests: -5 } });
    expect(repoMock.configSet).toHaveBeenCalledWith(
      "db_maintenance_settings",
      JSON.stringify({ retentionDays: { api_requests: 1 } }),
      expect.any(String),
    );
  });
});
