import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  publishWorkerPluginRequestSchema,
  updatePluginEnrollmentRequestSchema,
} from "@llm-gateway/shared";
import { workerPluginDb, userPluginEnrollmentDb } from "../db/index.js";
import {
  deletePluginVersion,
  listPluginVersions,
  publishPlugin,
  setPluginStatus,
  PluginStoreError,
} from "../agent/plugins/store.js";

const STORE_ERROR_STATUS: Record<string, number> = {
  duplicate_plugin_version: 409,
  plugin_version_conflict: 409,
  invalid_plugin_bundle: 400,
  plugin_in_use: 409,
};

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({
    error: { message, type: "invalid_request_error", param: null, code },
  });
}

// 插件 id 为反向域名，路径段中的 `.` 在 Fastify 路由参数中是合法字符
export async function workerPluginRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request: FastifyRequest) => {
    const userId = (request as any).user?.userId as string | undefined;
    const [plugins, enrollments] = await Promise.all([
      listPluginVersions(),
      userId ? userPluginEnrollmentDb.listByUser(userId) : Promise.resolve([]),
    ]);
    return {
      plugins: plugins.map((p) => ({
        id: p.id,
        version: p.version,
        digest: p.digest,
        name: p.name,
        description: p.description,
        status: p.status,
        changelog: p.changelog,
        model_profile: p.manifest.model_policy.profile,
        allow_client_override: p.manifest.model_policy.allow_client_override,
        tools: p.manifest.tool_policy.allow,
        max_turns: p.manifest.execution_policy.max_turns,
        timeout_seconds: p.manifest.execution_policy.timeout_seconds,
        published_at: p.published_at,
        deprecated_at: p.deprecated_at,
        revoked_at: p.revoked_at,
        created_at: p.created_at,
      })),
      enrollments: enrollments.map((e) => ({
        plugin_id: e.plugin_id,
        version: e.version,
        enabled: e.enabled === 1,
        is_default: e.is_default === 1,
        updated_at: e.updated_at,
      })),
    };
  });

  fastify.post("/", async (request, reply) => {
    const parsed = publishWorkerPluginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        "invalid_request",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    try {
      const info = await publishPlugin(parsed.data);
      return reply.code(201).send({
        id: info.id,
        version: info.version,
        digest: info.digest,
        status: info.status,
        published_at: info.published_at,
      });
    } catch (e) {
      if (e instanceof PluginStoreError) {
        return sendError(
          reply,
          STORE_ERROR_STATUS[e.code] ?? 400,
          e.code,
          e.message,
        );
      }
      throw e;
    }
  });

  fastify.post<{ Params: { id: string; version: string; action: string } }>(
    "/:id/:version/:action(deprecate|revoke|republish)",
    async (request, reply) => {
      const { id, version, action } = request.params;
      const status =
        action === "deprecate"
          ? "deprecated"
          : action === "revoke"
            ? "revoked"
            : "published";
      if (status === "published") {
        const row = await workerPluginDb.getByIdVersion(id, version);
        if (!row)
          return sendError(
            reply,
            404,
            "not_found",
            `plugin ${id}@${version} not found`,
          );
        if (row.status !== "deprecated") {
          return sendError(
            reply,
            409,
            "invalid_state",
            `only deprecated versions can be re-published; ${id}@${version} is ${row.status}`,
          );
        }
      }
      const updated = await setPluginStatus(id, version, status);
      if (!updated) {
        return sendError(
          reply,
          404,
          "not_found",
          `plugin ${id}@${version} not found`,
        );
      }
      return {
        id: updated.id,
        version: updated.version,
        status: updated.status,
        deprecated_at: updated.deprecated_at,
        revoked_at: updated.revoked_at,
      };
    },
  );

  fastify.delete<{ Params: { id: string; version: string } }>(
    "/:id/:version",
    async (request, reply) => {
      const { id, version } = request.params;
      try {
        const deleted = await deletePluginVersion(id, version);
        if (!deleted) {
          return sendError(
            reply,
            404,
            "not_found",
            `plugin ${id}@${version} not found`,
          );
        }
        return { id, version, deleted: true };
      } catch (e) {
        if (e instanceof PluginStoreError) {
          return sendError(
            reply,
            STORE_ERROR_STATUS[e.code] ?? 400,
            e.code,
            e.message,
          );
        }
        throw e;
      }
    },
  );

  fastify.put<{ Params: { pluginId: string } }>(
    "/enrollments/:pluginId",
    async (request, reply) => {
      const userId = (request as any).user?.userId as string | undefined;
      if (!userId) {
        return sendError(reply, 401, "unauthorized", "missing user identity");
      }
      const { pluginId } = request.params;
      const parsed = updatePluginEnrollmentRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "invalid_request",
          parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        );
      }
      const { version, enabled, is_default } = parsed.data;
      const plugin = await workerPluginDb.getByIdVersion(pluginId, version);
      if (!plugin) {
        return sendError(
          reply,
          404,
          "not_found",
          `plugin ${pluginId}@${version} not found`,
        );
      }
      if (plugin.status === "revoked") {
        return sendError(
          reply,
          403,
          "plugin_revoked",
          `plugin ${pluginId}@${version} has been revoked`,
        );
      }
      if (is_default && !enabled) {
        return sendError(
          reply,
          400,
          "invalid_request",
          "a disabled enrollment cannot be the default version",
        );
      }
      await userPluginEnrollmentDb.upsert({
        user_id: userId,
        plugin_id: pluginId,
        version,
        enabled: enabled ? 1 : 0,
        is_default: is_default ? 1 : 0,
      });
      if (is_default) {
        await userPluginEnrollmentDb.clearDefault(userId, pluginId, version);
      }
      return { plugin_id: pluginId, version, enabled, is_default };
    },
  );

  fastify.delete<{ Params: { pluginId: string } }>(
    "/enrollments/:pluginId",
    async (request, reply) => {
      const userId = (request as any).user?.userId as string | undefined;
      if (!userId) {
        return sendError(reply, 401, "unauthorized", "missing user identity");
      }
      const { pluginId } = request.params;
      const deleted = await userPluginEnrollmentDb.deleteByUserAndPlugin(
        userId,
        pluginId,
      );
      return { plugin_id: pluginId, deleted };
    },
  );
}
