import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
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

import { logApiRequestAsync, logApiRequestToDb } from "./api-request-logger.js";
import {
  modelDailyQuota,
  runWithQuotaContext,
  stampQuotaModel,
} from "./model-daily-quota.js";

const baseParams = {
  virtualKey: { id: "vk-1", disable_logging: 0 } as any,
  providerId: "prov-1",
  model: "gpt-x-real",
  status: "success" as const,
  responseTime: 10,
};

async function appWithQuotaHook(): Promise<FastifyInstance> {
  const app = Fastify();
  // Mirror index.ts: the scope must be entered with the callback-style hook,
  // otherwise the handler body would already be outside it.
  app.addHook("onRequest", (_request, _reply, done) => {
    runWithQuotaContext(done);
  });
  return app;
}

async function usedFor(model: string): Promise<number> {
  return (await modelDailyQuota.check(model)).usedTokens;
}

beforeEach(() => {
  vi.clearAllMocks();
  modelDailyQuota.resetForTesting();
  mocks.create.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({
    value: JSON.stringify({ "gpt-x": 100, "gpt-stream": 100, "gpt-late": 100 }),
  } as any);
  mocks.getDayUsage.mockResolvedValue({ consumedTokens: 0, requestCount: 0 });
  mocks.getDayTotals.mockResolvedValue([]);
  mocks.addUsage.mockResolvedValue(undefined);
});

test("usage recorded after awaits inside the handler still finds its model", async () => {
  const app = await appWithQuotaHook();
  app.get("/v1/chat/completions", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    stampQuotaModel("gpt-x");
    await new Promise((resolve) => process.nextTick(resolve));
    await logApiRequestToDb({
      ...baseParams,
      tokenCount: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    });
    return { ok: true };
  });

  await app.inject({ method: "GET", url: "/v1/chat/completions" });
  await app.close();

  expect(await usedFor("gpt-x")).toBe(1500);
});

test("a stream callback registered inside the request charges the same model", async () => {
  const app = await appWithQuotaHook();
  app.get("/v1/stream", (_request, reply) => {
    stampQuotaModel("gpt-stream");
    const bus = new EventEmitter();
    bus.on("done", () => {
      // Fire-and-forget, exactly like the streaming proxy handlers do.
      logApiRequestAsync({
        ...baseParams,
        model: "gpt-stream",
        tokenCount: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
      });
    });
    setTimeout(() => bus.emit("done"), 5);
    reply.hijack();
    reply.raw.end("ok");
  });

  await app.inject({ method: "GET", url: "/v1/stream" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await app.close();

  expect(await usedFor("gpt-stream")).toBe(50);
});

test("a request that never resolved a model charges nothing", async () => {
  const app = await appWithQuotaHook();
  app.get("/v1/unresolved", async () => {
    await logApiRequestToDb({
      ...baseParams,
      tokenCount: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    return { ok: true };
  });

  await app.inject({ method: "GET", url: "/v1/unresolved" });
  await app.close();

  expect(await usedFor("gpt-late")).toBe(0);
});
