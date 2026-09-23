import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/ops-metrics.js", () => ({
  getOpsOverview: vi.fn().mockResolvedValue({}),
  getOpsTrend: vi.fn().mockResolvedValue({}),
  getOpsDimensionList: vi.fn().mockResolvedValue({}),
  resolveWindow: vi.fn(),
  isOpsPeriod: (value: unknown) =>
    value === "24h" || value === "7d" || value === "30d",
}));

import { opsMetricsRoutes } from "./ops-metrics.js";
import { resolveWindow } from "../services/ops-metrics.js";

describe("ops-metrics query errors", () => {
  it.each([
    "/ops-metrics/overview?period=invalid",
    "/ops-metrics/trend?period=invalid",
    "/ops-metrics/dimensions/invalid?period=24h",
  ])("returns an OpenAI-style 400 envelope for %s", async (url) => {
    const app = Fastify();
    app.decorate("authenticate", async () => {});
    await app.register(opsMetricsRoutes);
    try {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: expect.any(String),
          type: "invalid_request_error",
          param: null,
          code: "invalid_ops_metrics_query",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("passes a valid pinned endTime through to resolveWindow", async () => {
    const app = Fastify();
    app.decorate("authenticate", async () => {});
    await app.register(opsMetricsRoutes);
    try {
      const endTime = Date.now() - 1000;
      await app.inject({
        method: "GET",
        url: `/ops-metrics/overview?period=24h&endTime=${endTime}`,
      });
      expect(resolveWindow).toHaveBeenCalledWith("24h", endTime);
    } finally {
      await app.close();
    }
  });

  it.each(["endTime=abc", "endTime=0", `endTime=${Date.now() + 10 * 60_000}`])(
    "rejects an out-of-range %s",
    async (endTimeQuery) => {
      const app = Fastify();
      app.decorate("authenticate", async () => {});
      await app.register(opsMetricsRoutes);
      try {
        const response = await app.inject({
          method: "GET",
          url: `/ops-metrics/overview?period=24h&${endTimeQuery}`,
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    },
  );
});
