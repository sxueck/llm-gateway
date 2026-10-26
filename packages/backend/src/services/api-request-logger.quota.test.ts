import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  apiRequestDb: { create: mocks.create },
  systemConfigDb: { get: mocks.get, set: vi.fn() },
  modelDailyUsageDb: {
    addUsage: mocks.addUsage,
    getDayUsage: mocks.getDayUsage,
    getDayTotals: mocks.getDayTotals,
    renameDayUsage: mocks.renameDayUsage,
    deleteBefore: mocks.deleteBefore,
  },
}));

import { logApiRequestToDb } from "./api-request-logger.js";
import {
  modelDailyQuota,
  runWithQuotaContext,
  stampQuotaModel,
} from "./model-daily-quota.js";

const NOW = new Date("2026-03-02T12:00:00+08:00").getTime();

const baseParams = {
  virtualKey: { id: "vk-1", disable_logging: 0 } as any,
  providerId: "prov-1",
  model: "gpt-x-real",
  tokenCount: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
  status: "success" as const,
  responseTime: 100,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.create.mockResolvedValue(undefined);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
  mocks.renameDayUsage.mockResolvedValue(undefined);
  // 配额对计量没有开关：未配置额度的模型也要累计，中途设上限才看得见当天已用量。
  // 这里给两个名字都配上限，否则 check() 对未配置模型直接返回 0 用量。
  mocks.get.mockResolvedValue({
    value: JSON.stringify({ "gpt-x": 100, "gpt-virtual": 100 }),
  } as any);
  modelDailyQuota.resetForTesting();
});

async function usedFor(model: string): Promise<number> {
  const verdict = await modelDailyQuota.check(model, NOW);
  return verdict.usedTokens;
}

test("the logger settles prompt+completion against the addressed model", async () => {
  await logApiRequestToDb({ ...baseParams, quotaModel: "gpt-x" });

  expect(await usedFor("gpt-x")).toBe(1500);
});

test("a cached response still counts: no discount for cache hits", async () => {
  await logApiRequestToDb({
    ...baseParams,
    quotaModel: "gpt-x",
    cacheHit: 1,
    cachedTokens: 1000,
  });

  expect(await usedFor("gpt-x")).toBe(1500);
});

test("the request-scoped quota context covers call sites that pass no model", async () => {
  await runWithQuotaContext(async () => {
    stampQuotaModel("gpt-virtual");
    await logApiRequestToDb(baseParams);
  });

  expect(await usedFor("gpt-virtual")).toBe(1500);
});

test("requests without any quota identity change nothing", async () => {
  await logApiRequestToDb(baseParams);

  expect(await usedFor("gpt-x")).toBe(0);
});
