import type { FastifyInstance, FastifyReply } from "fastify";
import {
  buildPurgePlans,
  getLastRun,
  getMaintenanceSettings,
  getTableSizes,
  isValidPurgeTarget,
  listPurgeTargets,
  normalizeSettings,
  optimizeTables,
  recordLastRun,
  runPurge,
  saveMaintenanceSettings,
} from "../services/db-maintenance-service.js";

function httpError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function respondError(reply: FastifyReply, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (error instanceof Error && typeof statusCode === "number") {
    return reply.code(statusCode).send(errorResponse(statusCode, error.message));
  }
  return reply.code(500).send(internalErrorResponse(error));
}

function errorResponse(statusCode: number, message: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: null,
      code: statusCode === 404 ? "not_found" : "validation_error",
    },
  };
}

function internalErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      message,
      type: "internal_error",
      param: null,
      code: "db_maintenance_failed",
    },
  };
}

export default async function dbMaintenanceRoutes(fastify: FastifyInstance) {
  fastify.get(
    "/api/admin/db-maintenance/overview",
    { onRequest: [fastify.authenticate] },
    async (_request, reply) => {
      try {
        const [tables, settings, lastRun] = await Promise.all([
          getTableSizes(),
          getMaintenanceSettings(),
          getLastRun(),
        ]);
        const purgeTargets = await buildPurgePlans(listPurgeTargets(), settings);
        return { tables, purgeTargets, settings, lastRun };
      } catch (error) {
        return reply.code(500).send(internalErrorResponse(error));
      }
    },
  );

  fastify.put(
    "/api/admin/db-maintenance/settings",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as { retentionDays?: Record<string, unknown> };
        if (typeof body.retentionDays !== "object" || body.retentionDays === null) {
          throw httpError(400, "retentionDays must be an object");
        }
        for (const [table, days] of Object.entries(body.retentionDays)) {
          if (!isValidPurgeTarget(table)) {
            throw httpError(400, `unknown purge target: ${table}`);
          }
          if (!Number.isInteger(Number(days))) {
            throw httpError(400, `retentionDays.${table} must be an integer (days)`);
          }
        }
        const settings = normalizeSettings(body);
        await saveMaintenanceSettings(settings);
        return { settings };
      } catch (error) {
        return respondError(reply, error);
      }
    },
  );

  fastify.post(
    "/api/admin/db-maintenance/purge",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as {
          targets?: unknown;
          dryRun?: unknown;
        };
        if (!Array.isArray(body.targets) || body.targets.length === 0) {
          throw httpError(400, "targets must be a non-empty array");
        }
        for (const target of body.targets) {
          if (typeof target !== "string" || !isValidPurgeTarget(target)) {
            throw httpError(400, `unknown purge target: ${String(target)}`);
          }
        }
        if (typeof body.dryRun !== "boolean") {
          throw httpError(400, "dryRun must be a boolean");
        }
        const targets = body.targets as string[];
        const settings = await getMaintenanceSettings();

        if (body.dryRun) {
          const plans = await buildPurgePlans(targets, settings);
          return { dryRun: true, plans };
        }

        const results = await runPurge(targets, settings);
        const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
        await recordLastRun({
          type: "purge",
          at: Date.now(),
          summary: `清理 ${results.length} 张表，共删除 ${deleted} 行`,
        });
        return { dryRun: false, results, deleted };
      } catch (error) {
        return respondError(reply, error);
      }
    },
  );

  fastify.post(
    "/api/admin/db-maintenance/optimize",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as { tables?: unknown };
        if (
          !Array.isArray(body.tables) ||
          body.tables.length === 0 ||
          !body.tables.every((t) => typeof t === "string")
        ) {
          throw httpError(400, "tables must be a non-empty array of strings");
        }
        const tables = body.tables as string[];
        const results = await optimizeTables(tables);
        await recordLastRun({
          type: "optimize",
          at: Date.now(),
          summary: `优化 ${results.filter((r) => r.ok).length}/${results.length} 张表`,
        });
        return { results };
      } catch (error) {
        return respondError(reply, error);
      }
    },
  );
}
