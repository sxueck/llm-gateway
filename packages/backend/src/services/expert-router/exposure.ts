import type { FastifyReply } from "fastify";
import type { ExposureConfig, RoutingBand } from "../../types/expert-routing.js";

/**
 * Routing facts for one proxied request (PRD §4). Produced by ExpertRouter
 * and threaded through model resolution into the protocol handlers, where
 * they are exposed via response headers and (optionally) the body model field.
 */
export interface ExpertRouteInfo {
  expertRoutingId: string;
  tier?: RoutingBand;
  routeSource: "jev" | "session" | "fallback" | "fail_open" | "manual";
  logId: string | null;
  /** Gateway display name of the routed model (resolvedModel.name). */
  routedModelName?: string;
  exposure?: ExposureConfig;
}

export type RequiredExposureConfig = Required<ExposureConfig>;

export const DEFAULT_EXPOSURE: RequiredExposureConfig = {
  headers: true,
  provider_header: false,
  model_field: "upstream",
  sse_comment: false,
};

export function resolveExposure(routeInfo?: ExpertRouteInfo | null): RequiredExposureConfig {
  return { ...DEFAULT_EXPOSURE, ...(routeInfo?.exposure ?? {}) };
}

export interface RouteHeaderOptions {
  routeInfo?: ExpertRouteInfo | null;
  /** Model identifier actually sent upstream (post retry/fallback). */
  upstreamModel?: string | null;
  providerName?: string | null;
  /** Overrides routeInfo.routeSource, e.g. "cache" on a cache hit. */
  routeSourceOverride?: string;
  /** Entry model display name when no routeInfo exists (early cache hit). */
  fallbackRoutedModel?: string | null;
}

/**
 * Build the X-Gateway-* header set; null when there is nothing to expose
 * (no routeInfo and no cache override, or headers disabled).
 */
export function buildRouteHeaders(options: RouteHeaderOptions): Record<string, string> | null {
  const { routeInfo } = options;
  const source: string | undefined =
    options.routeSourceOverride ?? routeInfo?.routeSource;
  // source is only undefined when routeInfo is absent and no override was given.
  if (!source) return null;
  if (routeInfo && !resolveExposure(routeInfo).headers) return null;
  const headers: Record<string, string> = {
    "X-Gateway-Routed-Model":
      routeInfo?.routedModelName ?? options.fallbackRoutedModel ?? "",
    "X-Gateway-Upstream-Model": options.upstreamModel ?? "",
  };
  if (routeInfo?.tier) {
    headers["X-Gateway-Route-Tier"] = routeInfo.tier;
  }
  headers["X-Gateway-Route-Source"] = source;
  if (routeInfo?.logId) {
    headers["X-Gateway-Route-Id"] = routeInfo.logId;
  }
  // Off by default: provider names are operational information.
  if (
    routeInfo &&
    resolveExposure(routeInfo).provider_header &&
    options.providerName
  ) {
    headers["X-Gateway-Provider"] = options.providerName;
  }
  return headers;
}

const EXPOSE_HEADERS = "Access-Control-Expose-Headers";

/**
 * Write the route headers on both Fastify and the raw response: streams go
 * through reply.raw.writeHead(), which merges (not replaces) prior setHeader
 * values — the same trick X-Max-Completion-Tokens uses.
 */
export function applyRouteHeaders(reply: FastifyReply, options: RouteHeaderOptions): void {
  const headers = buildRouteHeaders(options);
  if (!headers) return;
  const names = Object.keys(headers);
  for (const name of names) {
    const value = headers[name];
    reply.header(name, value);
    reply.raw.setHeader(name, value);
  }
  const existing = reply.getHeader(EXPOSE_HEADERS);
  const existingNames =
    typeof existing === "string" ? existing.split(",").map((item) => item.trim()) : [];
  const merged = [...new Set([...existingNames, ...names])].filter(Boolean).join(", ");
  reply.header(EXPOSE_HEADERS, merged);
  reply.raw.setHeader(EXPOSE_HEADERS, merged);
}

/**
 * Resolve the `model` value reported to the client (B layer). Default keeps
 * the upstream identifier (byte-identical passthrough); "gateway_name"
 * replaces it with the gateway's model display name.
 */
export function modelFieldForClient(
  upstreamModel: string | undefined | null,
  routeInfo?: ExpertRouteInfo | null,
): string | undefined {
  if (!routeInfo) return upstreamModel ?? undefined;
  if (resolveExposure(routeInfo).model_field !== "gateway_name") {
    return upstreamModel ?? undefined;
  }
  return routeInfo.routedModelName ?? upstreamModel ?? undefined;
}
