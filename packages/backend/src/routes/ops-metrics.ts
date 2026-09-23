import type { FastifyInstance } from "fastify";
import {
  getOpsOverview,
  getOpsTrend,
  getOpsDimensionList,
  resolveWindow,
  isOpsPeriod,
  type OpsPeriod,
} from "../services/ops-metrics.js";
import type {
  OpsDimension,
  OpsFilters,
} from "../db/repositories/ops-metrics.repository.js";

const DIMENSIONS = new Set<OpsDimension>(["virtualKey", "model", "provider"]);

interface OpsQueryParams {
  period?: string;
  virtualKeyId?: string;
  model?: string;
  providerId?: string;
}

function parseWindowAndFilters(
  query: OpsQueryParams,
): { period: OpsPeriod; filters: OpsFilters } | { error: string } {
  if (!isOpsPeriod(query.period)) {
    return { error: "period must be one of 24h, 7d, 30d" };
  }
  const filters: OpsFilters = {};
  if (query.virtualKeyId) filters.virtualKeyId = String(query.virtualKeyId);
  if (query.model) filters.model = String(query.model);
  if (query.providerId) filters.providerId = String(query.providerId);
  return { period: query.period, filters };
}

export async function opsMetricsRoutes(fastify: FastifyInstance) {
  // Same admin authentication scope as /api/admin/config routes.
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/ops-metrics/overview", async (request) => {
    const parsed = parseWindowAndFilters(request.query as OpsQueryParams);
    if ("error" in parsed) {
      return reply400(fastify, parsed.error);
    }
    // endTime is fixed once per refresh so every card/chart of this request
    // samples the same instant.
    return getOpsOverview(resolveWindow(parsed.period), parsed.filters);
  });

  fastify.get("/ops-metrics/trend", async (request) => {
    const parsed = parseWindowAndFilters(request.query as OpsQueryParams);
    if ("error" in parsed) {
      return reply400(fastify, parsed.error);
    }
    return getOpsTrend(resolveWindow(parsed.period), parsed.filters);
  });

  fastify.get("/ops-metrics/dimensions/:dimension", async (request) => {
    const parsed = parseWindowAndFilters(request.query as OpsQueryParams);
    if ("error" in parsed) {
      return reply400(fastify, parsed.error);
    }
    const { dimension } = request.params as { dimension: string };
    if (!DIMENSIONS.has(dimension as OpsDimension)) {
      return reply400(
        fastify,
        "dimension must be one of virtualKey, model, provider",
      );
    }
    const q = request.query as OpsQueryParams & {
      search?: string;
      sortBy?: string;
      sortOrder?: string;
      page?: string;
      pageSize?: string;
    };
    return getOpsDimensionList(resolveWindow(parsed.period), {
      dimension: dimension as OpsDimension,
      filters: parsed.filters,
      search: q.search ? String(q.search) : undefined,
      sortBy: q.sortBy ? String(q.sortBy) : undefined,
      sortOrder: q.sortOrder === "asc" ? "asc" : "desc",
      page: q.page ? parseInt(String(q.page), 10) || 1 : 1,
      pageSize: q.pageSize ? parseInt(String(q.pageSize), 10) || 20 : 20,
    });
  });
}

function reply400(_fastify: FastifyInstance, message: string) {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 400;
  throw err;
}
