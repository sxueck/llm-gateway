import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  getAll: vi.fn(),
  getByVirtualKeyId: vi.fn(),
  applyBulk: vi.fn(),
  renameQuotaModel: vi.fn(),
  addUsage: vi.fn(),
  getDayUsage: vi.fn(),
  getDayTotals: vi.fn(),
  renameDayUsage: vi.fn(),
  deleteBefore: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  apiRequestDb: { create: mocks.create },
  virtualKeyModelQuotaDb: {
    getAll: mocks.getAll,
    getByVirtualKeyId: mocks.getByVirtualKeyId,
    applyBulk: mocks.applyBulk,
    renameModel: mocks.renameQuotaModel,
  },
  virtualKeyModelUsageDb: {
    addUsage: mocks.addUsage,
    getDayUsage: mocks.getDayUsage,
    getDayTotals: mocks.getDayTotals,
    renameDayUsage: mocks.renameDayUsage,
    deleteBefore: mocks.deleteBefore,
  },
}));

import { logApiRequestToDb } from "./api-request-logger.js";
import {
  currentQuotaModel,
  runWithQuotaContext,
  stampQuotaModel,
  virtualKeyQuota,
} from "./virtual-key-quota.js";

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
  mocks.getByVirtualKeyId.mockResolvedValue([]);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
  mocks.renameDayUsage.mockResolvedValue(undefined);
  // 配额对计量没有开关：未配置额度的 (密钥, 模型) 也要累计，中途设上限才看得见当天已用量。
  // 这里给涉及的 (密钥, 模型) 都配上限，否则 check() 对未配置组合直接返回 0 用量。
  mocks.getAll.mockResolvedValue([
    { virtualKeyId: "vk-1", model: "gpt-x", limitMillions: 100 },
    { virtualKeyId: "vk-1", model: "gpt-virtual", limitMillions: 100 },
    { virtualKeyId: "vk-quiet", model: "gpt-x", limitMillions: 100 },
  ]);
  virtualKeyQuota.resetForTesting();
});

async function usedFor(virtualKeyId: string, model: string): Promise<number> {
  const verdict = await virtualKeyQuota.check(virtualKeyId, model, NOW);
  return verdict.usedTokens;
}

test("the logger settles prompt+completion against the key's budget for the addressed model", async () => {
  await logApiRequestToDb({ ...baseParams, quotaModel: "gpt-x" });

  expect(await usedFor("vk-1", "gpt-x")).toBe(1500);
});

test("usage stays scoped to the virtual key that made the request", async () => {
  await logApiRequestToDb({ ...baseParams, quotaModel: "gpt-x" });

  expect(await usedFor("vk-1", "gpt-x")).toBe(1500);
  expect(await usedFor("vk-other", "gpt-x")).toBe(0);
});

test("a cached response still counts: no discount for cache hits", async () => {
  await logApiRequestToDb({
    ...baseParams,
    quotaModel: "gpt-x",
    cacheHit: 1,
    cachedTokens: 1000,
  });

  expect(await usedFor("vk-1", "gpt-x")).toBe(1500);
});

test("a logging-disabled key is still charged", async () => {
  // disable_logging 只抑制存储的元数据，配额计量必须照常，否则关日志即可绕过额度。
  await logApiRequestToDb({
    ...baseParams,
    virtualKey: { id: "vk-quiet", disable_logging: 1 } as any,
    quotaModel: "gpt-x",
  });

  expect(await usedFor("vk-quiet", "gpt-x")).toBe(1500);
});

test("the request-scoped quota context covers call sites that pass no model", async () => {
  await runWithQuotaContext(async () => {
    stampQuotaModel("gpt-virtual");
    await logApiRequestToDb(baseParams);
  });

  expect(await usedFor("vk-1", "gpt-virtual")).toBe(1500);
});

test("requests without any quota identity change nothing", async () => {
  await runWithQuotaContext(async () => {
    await logApiRequestToDb(baseParams);
  });

  expect(currentQuotaModel()).toBeUndefined();
  expect(await usedFor("vk-1", "gpt-x")).toBe(0);
});
