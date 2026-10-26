import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
  // Stand-in for the model_daily_usage table: rows keyed by `${date}|${model}`.
  rows: new Map<string, { tokens: number; requests: number }>(),
  batches: new Set<string>(),
}));

vi.mock("../db/index.js", () => ({
  systemConfigDb: { get: mocks.get, set: mocks.set },
  modelDailyUsageDb: {
    addUsage: mocks.addUsage,
    getDayUsage: mocks.getDayUsage,
    getDayTotals: mocks.getDayTotals,
    renameDayUsage: mocks.renameDayUsage,
    deleteBefore: mocks.deleteBefore,
  },
}));

import {
  currentQuotaModel,
  MODEL_DAILY_TOKEN_LIMITS_CONFIG_KEY,
  modelDailyQuota,
  runWithQuotaContext,
  stampQuotaModel,
} from "./model-daily-quota.js";

const DAY_1 = new Date("2026-03-02T12:00:00+08:00").getTime();
const DAY_2 = new Date("2026-03-03T00:10:00+08:00").getTime();

function configureLimits(limits: Record<string, number>) {
  mocks.get.mockResolvedValue({ value: JSON.stringify(limits) } as any);
}

function applyDeltas(deltas: any[]) {
  for (const delta of deltas) {
    const key = `${delta.usageDate}|${delta.model}`;
    const row = mocks.rows.get(key) || { tokens: 0, requests: 0 };
    row.tokens += delta.consumedTokens;
    row.requests += delta.requestCount;
    mocks.rows.set(key, row);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(DAY_1);
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.batches.clear();
  modelDailyQuota.resetForTesting();
  mocks.addUsage.mockImplementation(async (deltas: any[], batchId: string) => {
    if (mocks.batches.has(batchId)) return;
    mocks.batches.add(batchId);
    applyDeltas(deltas);
  });
  mocks.getDayUsage.mockImplementation(async (model: string, date: string) => {
    const row = mocks.rows.get(`${date}|${model}`);
    return { consumedTokens: row?.tokens ?? 0, requestCount: row?.requests ?? 0 };
  });
  mocks.getDayTotals.mockImplementation(async (date: string) =>
    [...mocks.rows.entries()]
      .filter(([key]) => key.startsWith(`${date}|`))
      .map(([key, row]) => ({
        model: key.slice(date.length + 1),
        consumedTokens: row.tokens,
        requestCount: row.requests,
      })),
  );
  mocks.renameDayUsage.mockImplementation(
    async (date: string, from: string, to: string) => {
      const source = mocks.rows.get(`${date}|${from}`);
      if (!source) return;
      mocks.rows.delete(`${date}|${from}`);
      const key = `${date}|${to}`;
      const target = mocks.rows.get(key) || { tokens: 0, requests: 0 };
      target.tokens += source.tokens;
      target.requests += source.requests;
      mocks.rows.set(key, target);
    },
  );
  mocks.deleteBefore.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("model daily token quota", () => {
  it("leaves models without a configured ceiling unlimited", async () => {
    configureLimits({});
    const verdict = await modelDailyQuota.check("gpt-uncapped", DAY_1);

    expect(verdict.allowed).toBe(true);
    expect(verdict.limitTokens).toBe(0);
  });

  it("reads the ceiling in millions of tokens", async () => {
    configureLimits({ "gpt-x": 2 });
    mocks.rows.set("2026-03-02|gpt-x", { tokens: 2_000_000, requests: 40 });

    const verdict = await modelDailyQuota.check("gpt-x", DAY_1);

    expect(verdict.limitTokens).toBe(2_000_000);
    expect(verdict.usedTokens).toBe(2_000_000);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
  });

  it("blocks once settled usage reaches the ceiling", async () => {
    configureLimits({ "gpt-x": 1 });

    modelDailyQuota.record("gpt-x", 600_000, DAY_1);
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).allowed).toBe(true);

    modelDailyQuota.record("gpt-x", 400_000, DAY_1);
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).allowed).toBe(false);
  });

  it("keeps a virtual model's budget separate from the real model it routes to", async () => {
    configureLimits({ "v-claude": 1 });

    // 真实模型自身的流量不进虚拟模型的桶，反之亦然。
    modelDailyQuota.record("claude-3-5-sonnet", 5_000_000, DAY_1);
    expect((await modelDailyQuota.check("v-claude", DAY_1)).allowed).toBe(true);

    modelDailyQuota.record("v-claude", 1_000_000, DAY_1);
    expect((await modelDailyQuota.check("v-claude", DAY_1)).allowed).toBe(false);
    expect((await modelDailyQuota.check("claude-3-5-sonnet", DAY_1)).allowed).toBe(true);
  });

  it("merges a day's records into one delta row per model", async () => {
    configureLimits({ "gpt-x": 10 });
    modelDailyQuota.record("gpt-x", 100, DAY_1);
    modelDailyQuota.record("gpt-x", 200, DAY_1);
    modelDailyQuota.record("gpt-x", 300, DAY_1);

    await modelDailyQuota.flush();

    expect(mocks.addUsage).toHaveBeenCalledTimes(1);
    expect(mocks.addUsage).toHaveBeenCalledWith(
      [
        {
          usageDate: "2026-03-02",
          model: "gpt-x",
          consumedTokens: 600,
          requestCount: 3,
        },
      ],
      expect.any(String),
    );
  });

  it("retries an unknown commit outcome with the same id without double counting", async () => {
    configureLimits({ "gpt-x": 1 });
    modelDailyQuota.record("gpt-x", 600_000, DAY_1);
    mocks.addUsage.mockImplementation(async (deltas: any[], batchId: string) => {
      if (mocks.batches.has(batchId)) return;
      mocks.batches.add(batchId);
      applyDeltas(deltas);
      if (mocks.addUsage.mock.calls.length === 1) {
        throw new Error("commit response lost");
      }
    });

    await expect(modelDailyQuota.flush()).rejects.toThrow("commit response lost");
    expect(mocks.rows.get("2026-03-02|gpt-x")?.tokens).toBe(600_000);

    await modelDailyQuota.flush();

    expect(mocks.addUsage).toHaveBeenCalledTimes(2);
    expect(mocks.addUsage.mock.calls[0][1]).toBe(mocks.addUsage.mock.calls[1][1]);
    expect(mocks.addUsage.mock.calls[0][0]).toEqual(mocks.addUsage.mock.calls[1][0]);
    expect(mocks.rows.get("2026-03-02|gpt-x")?.tokens).toBe(600_000);
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).usedTokens).toBe(600_000);
  });

  it("serializes the initial read with an in-flight write of the same cell", async () => {
    configureLimits({ "gpt-x": 1 });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    mocks.addUsage.mockImplementation(async (deltas: any[], batchId: string) => {
      if (mocks.batches.has(batchId)) return;
      mocks.batches.add(batchId);
      applyDeltas(deltas);
      await writeGate;
    });
    modelDailyQuota.record("gpt-x", 600_000, DAY_1);

    const flushing = modelDailyQuota.flush();
    await vi.waitFor(() => expect(mocks.addUsage).toHaveBeenCalledTimes(1));
    const checking = modelDailyQuota.check("gpt-x", DAY_1);
    await Promise.resolve();
    expect(mocks.getDayUsage).not.toHaveBeenCalled();

    releaseWrite();
    await flushing;

    expect((await checking).usedTokens).toBe(600_000);
  });

  it("recovers the day's total from the table after a restart", async () => {
    configureLimits({ "gpt-x": 1 });
    modelDailyQuota.record("gpt-x", 900_000, DAY_1);
    await modelDailyQuota.flush();
    modelDailyQuota.resetForTesting();

    const verdict = await modelDailyQuota.check("gpt-x", DAY_1);
    expect(verdict.allowed).toBe(true);
    expect(verdict.usedTokens).toBe(900_000);

    modelDailyQuota.record("gpt-x", 200_000, DAY_1);
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).allowed).toBe(false);
    // 已落盘的基线 + 未落盘的增量，绝不重复相加。
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).usedTokens).toBe(1_100_000);
  });

  it("resets on the next Asia/Shanghai day and prunes the old rows", async () => {
    configureLimits({ "gpt-x": 1 });
    modelDailyQuota.record("gpt-x", 2_000_000, DAY_1);
    await modelDailyQuota.flush();
    expect((await modelDailyQuota.check("gpt-x", DAY_1)).allowed).toBe(false);

    vi.setSystemTime(DAY_2);
    const nextDay = await modelDailyQuota.check("gpt-x", DAY_2);

    expect(nextDay.allowed).toBe(true);
    expect(nextDay.usedTokens).toBe(0);
    expect(mocks.deleteBefore).toHaveBeenCalledWith("2026-03-03");
  });

  it("follows a model rename so a ceiling is never silently dropped", async () => {
    configureLimits({ "old-name": 3 });

    await modelDailyQuota.renameModelKey("old-name", "new-name");

    const stored = JSON.parse(mocks.set.mock.calls[0][1]);
    expect(stored).toEqual({ "new-name": 3 });
    expect(mocks.set.mock.calls[0][0]).toBe(MODEL_DAILY_TOKEN_LIMITS_CONFIG_KEY);
    expect((await modelDailyQuota.check("new-name", DAY_1)).limitTokens).toBe(3_000_000);
  });

  it("defers the in-memory rename until the surrounding transaction commits", async () => {
    configureLimits({ "old-name": 3 });

    const commit = await modelDailyQuota.renameModelKey("old-name", "new-name", {} as any);
    expect(modelDailyQuota.limitTokensFor("old-name", await modelDailyQuota.getConfiguredLimits())).toBe(3_000_000);
    expect(modelDailyQuota.limitTokensFor("new-name", await modelDailyQuota.getConfiguredLimits())).toBe(0);

    commit();
    expect(modelDailyQuota.limitTokensFor("old-name", await modelDailyQuota.getConfiguredLimits())).toBe(0);
    expect(modelDailyQuota.limitTokensFor("new-name", await modelDailyQuota.getConfiguredLimits())).toBe(3_000_000);
  });

  it("propagates a config write failure without changing the in-memory rename", async () => {
    configureLimits({ "old-name": 3 });
    mocks.set.mockRejectedValueOnce(new Error("config write failed"));

    await expect(modelDailyQuota.renameModelKey("old-name", "new-name")).rejects.toThrow(
      "config write failed",
    );

    expect(mocks.renameDayUsage).not.toHaveBeenCalled();
    expect(modelDailyQuota.limitTokensFor("old-name", await modelDailyQuota.getConfiguredLimits())).toBe(3_000_000);
    expect(modelDailyQuota.limitTokensFor("new-name", await modelDailyQuota.getConfiguredLimits())).toBe(0);
  });

  it("propagates a usage rename failure without moving the in-memory counter", async () => {
    configureLimits({ "old-name": 1 });
    modelDailyQuota.record("old-name", 900_000, DAY_1);
    await modelDailyQuota.flush();
    mocks.renameDayUsage.mockRejectedValueOnce(new Error("usage rename failed"));

    await expect(modelDailyQuota.renameModelKey("old-name", "new-name")).rejects.toThrow(
      "usage rename failed",
    );

    expect((await modelDailyQuota.check("old-name", DAY_1)).usedTokens).toBe(900_000);
    expect((await modelDailyQuota.check("new-name", DAY_1)).limitTokens).toBe(0);
  });

  it("ignores malformed ceiling entries", async () => {
    mocks.get.mockResolvedValue({
      value: JSON.stringify({ "gpt-bad": 0, "gpt-nan": "x", "gpt-ok": 1.5, "": 4 }),
    } as any);

    const limits = await modelDailyQuota.getConfiguredLimits();
    expect(limits).toEqual({ "gpt-ok": 1.5 });
  });

  it("picks up another instance's traffic on the next sync tick", async () => {
    configureLimits({ "gpt-x": 1 });
    modelDailyQuota.record("gpt-x", 400_000, DAY_1);
    await modelDailyQuota.flush();

    // 另一个实例写了 700k 到表里（本进程不知道）。
    mocks.rows.set("2026-03-02|gpt-x", { tokens: 1_100_000, requests: 7 });

    const before = await modelDailyQuota.check("gpt-x", DAY_1);
    expect(before.allowed).toBe(true);

    await modelDailyQuota.sync();
    const after = await modelDailyQuota.check("gpt-x", DAY_1);
    expect(after.usedTokens).toBe(1_100_000);
    expect(after.allowed).toBe(false);
  });

  it("carries today's counter when a model is renamed", async () => {
    configureLimits({ "old-name": 1 });
    modelDailyQuota.record("old-name", 900_000, DAY_1);
    await modelDailyQuota.flush();

    await modelDailyQuota.renameModelKey("old-name", "new-name");

    const verdict = await modelDailyQuota.check("new-name", DAY_1);
    expect(verdict.limitTokens).toBe(1_000_000);
    expect(verdict.usedTokens).toBe(900_000);
    expect(verdict.allowed).toBe(true);
  });

  it("exposes the addressed model through the request-scoped context", () => {
    expect(currentQuotaModel()).toBeUndefined();

    runWithQuotaContext(() => {
      stampQuotaModel("v-claude");
      expect(currentQuotaModel()).toBe("v-claude");
    });

    // 每个请求一份 holder，不会串到别的请求上。
    expect(currentQuotaModel()).toBeUndefined();
  });

  it("reports day totals of configured models for the settings page", async () => {
    configureLimits({ "gpt-x": 2, "gpt-y": 1 });
    modelDailyQuota.record("gpt-x", 700_000, DAY_1);

    const snapshot = await modelDailyQuota.snapshot(DAY_1);

    expect(snapshot.map((entry) => entry.model)).toEqual(["gpt-x", "gpt-y"]);
    expect(snapshot[0]).toMatchObject({
      model: "gpt-x",
      limitMillions: 2,
      limitTokens: 2_000_000,
      usedTokens: 700_000,
      requestCount: 1,
    });
  });
});
