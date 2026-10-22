import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_EXPOSURE,
  applyRouteHeaders,
  buildRouteHeaders,
  modelFieldForClient,
  resolveExposure,
  type ExpertRouteInfo,
} from "./exposure.js";

const routeInfo = (
  overrides: Partial<ExpertRouteInfo> = {},
): ExpertRouteInfo => ({
  expertRoutingId: "routing-1",
  tier: "high",
  routeSource: "jev",
  logId: "log-1",
  routedModelName: "Gateway Pro",
  ...overrides,
});

describe("buildRouteHeaders", () => {
  test("emits the full X-Gateway set by default", () => {
    expect(
      buildRouteHeaders({ routeInfo: routeInfo(), upstreamModel: "ep-123", providerName: "Acme" }),
    ).toEqual({
      "X-Gateway-Routed-Model": "Gateway Pro",
      "X-Gateway-Upstream-Model": "ep-123",
      "X-Gateway-Route-Tier": "high",
      "X-Gateway-Route-Source": "jev",
      "X-Gateway-Route-Id": "log-1",
    });
  });

  test("provider header is opt-in only", () => {
    const headers = buildRouteHeaders({
      routeInfo: routeInfo({ exposure: { provider_header: true } }),
      upstreamModel: "m",
      providerName: "Acme",
    });
    expect(headers?.["X-Gateway-Provider"]).toBe("Acme");
  });

  test("headers=false disables the whole set", () => {
    expect(
      buildRouteHeaders({ routeInfo: routeInfo({ exposure: { headers: false } }) }),
    ).toBeNull();
  });

  test("cache override works without routeInfo (early hit)", () => {
    expect(
      buildRouteHeaders({
        routeInfo: null,
        routeSourceOverride: "cache",
        upstreamModel: "ep-123",
        fallbackRoutedModel: "auto-pro",
      }),
    ).toEqual({
      "X-Gateway-Routed-Model": "auto-pro",
      "X-Gateway-Upstream-Model": "ep-123",
      "X-Gateway-Route-Source": "cache",
    });
  });

  test("null when neither routeInfo nor override", () => {
    expect(buildRouteHeaders({ upstreamModel: "m" })).toBeNull();
  });

  test("missing tier omits the tier header", () => {
    const headers = buildRouteHeaders({
      routeInfo: routeInfo({ tier: undefined }),
      upstreamModel: "m",
    });
    expect(headers).not.toHaveProperty("X-Gateway-Route-Tier");
  });
});

describe("applyRouteHeaders", () => {
  function createReplyStub() {
    const stored: Record<string, string> = {};
    return {
      stored,
      reply: {
        header: vi.fn((k: string, v: string) => {
          stored[k] = v;
        }),
        getHeader: vi.fn(() => undefined),
        raw: {
          setHeader: vi.fn((k: string, v: string) => {
            stored[k] = v;
          }),
        },
      } as any,
    };
  }

  test("writes both fastify and raw headers and merges expose-headers", () => {
    const { reply, stored } = createReplyStub();
    applyRouteHeaders(reply, { routeInfo: routeInfo(), upstreamModel: "ep-1" });
    expect(stored["X-Gateway-Route-Tier"]).toBe("high");
    expect(stored["X-Gateway-Route-Source"]).toBe("jev");
    expect(stored["Access-Control-Expose-Headers"]).toContain("X-Gateway-Route-Tier");
  });

  test("no-op without routeInfo", () => {
    const { reply } = createReplyStub();
    applyRouteHeaders(reply, {});
    expect(reply.header).not.toHaveBeenCalled();
  });
});

describe("modelFieldForClient", () => {
  test("default keeps the upstream identifier (byte-identical)", () => {
    expect(modelFieldForClient("ep-123", routeInfo())).toBe("ep-123");
    expect(modelFieldForClient("ep-123", null)).toBe("ep-123");
  });

  test("gateway_name swaps in the routed model display name", () => {
    expect(
      modelFieldForClient("ep-123", routeInfo({ exposure: { model_field: "gateway_name" } })),
    ).toBe("Gateway Pro");
  });
});

describe("resolveExposure", () => {
  test("defaults and per-route overrides", () => {
    expect(resolveExposure(null)).toEqual(DEFAULT_EXPOSURE);
    expect(resolveExposure(routeInfo({ exposure: { sse_comment: true } })).sse_comment).toBe(true);
    expect(resolveExposure(routeInfo({ exposure: { sse_comment: true } })).headers).toBe(true);
  });
});
