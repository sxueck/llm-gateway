import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/ops-metrics.js", () => ({
  getOpsOverview: vi.fn(),
  getOpsTrend: vi.fn(),
  getOpsDimensionList: vi.fn(),
  resolveWindow: vi.fn(),
  isOpsPeriod: (value: unknown) =>
    value === "24h" || value === "7d" || value === "30d",
}));

import { opsMetricsRoutes } from "./ops-metrics.js";

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
});
