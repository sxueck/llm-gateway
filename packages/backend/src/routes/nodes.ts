import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nodeHealthSchema, type NodeCheckResult, type NodesOverview } from "@llm-gateway/shared";
import { appConfig } from "../config/index.js";
import { listExecutableNodeIds } from "../config/node.js";
import { providerDb } from "../db/index.js";
import { nodeError, providerOwner } from "../services/node-dispatch.js";
import { forwardNodeOperation } from "../services/node-operations.js";

const CHECK_TIMEOUT_MS = 8000;
const pendingChecks = new Map<string, Promise<NodeCheckResult>>();

async function checkPeer(nodeId: string): Promise<NodeCheckResult> {
  const startedAt = Date.now();
  const result: NodeCheckResult = {
    nodeId, reachable: null, authenticated: null, latencyMs: 0, checkedAt: 0, errorCode: null,
  };
  try {
    const outcome = await forwardNodeOperation(nodeId, { op: "node-health" }, CHECK_TIMEOUT_MS);
    result.reachable = true;
    const health = nodeHealthSchema.safeParse(outcome.body);
    const saturated = z.object({ error: z.object({ code: z.literal("node_dispatch_saturated") }) }).safeParse(outcome.body).success;
    result.authenticated = outcome.status === 503 ? null : outcome.status === 200 && health.success &&
      health.data.nodeId === nodeId && health.data.controlId === appConfig.node.controlId;
    if (!result.authenticated) {
      result.errorCode = outcome.status === 401 ? "peer_node_auth_failed" :
        outcome.status === 403 ? "node_operation_forbidden" :
        outcome.status === 503 ? (saturated ? "node_dispatch_saturated" : "node_dispatch_unavailable") : "node_health_mismatch";
    }
  } catch (error) {
    if (error instanceof Error && error.message === "peer_node_auth_failed") {
      result.reachable = true;
      result.authenticated = false;
      result.errorCode = "peer_node_auth_failed";
    } else {
      // Failure before a verified response cannot distinguish a down peer from a broken link.
      result.errorCode = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "node_check_timeout" : "owner_node_unavailable";
    }
  }
  result.checkedAt = Date.now();
  result.latencyMs = result.checkedAt - startedAt;
  return result;
}

export async function nodeAdminRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);
  // 非控制节点的准入由 index.ts 的 registerNodeControlGuard 全局 onRequest 钩子负责
  // （/api/admin 前缀，父作用域钩子先于本路由执行），此处不再重复判定。

  fastify.get("/", async (_request, reply): Promise<NodesOverview | typeof reply> => {
    const { enabled, id: nodeId, controlId, peers } = appConfig.node;
    if (!enabled) return { enabled, nodeId, controlId, nodes: [], providers: [] };
    try {
      const nodeIds = listExecutableNodeIds(appConfig.node);
      const providers = await providerDb.getAll();
      return {
        enabled, nodeId, controlId,
        nodes: nodeIds.map((id) => ({ id, origin: id === nodeId ? null : peers[id], local: id === nodeId, control: id === controlId })),
        providers: providers.map((provider) => {
          const ownerNode = providerOwner(provider);
          return { id: provider.id, name: provider.name, ownerNode, enabled: provider.enabled === 1, configured: nodeIds.includes(ownerNode) };
        }),
      };
    } catch {
      return reply.code(500).send(nodeError("node_overview_failed", "Unable to load node overview"));
    }
  });

  fastify.post<{ Params: { id: string } }>("/:id/check", async (request, reply) => {
    const { id } = request.params;
    if (!appConfig.node.enabled) {
      return reply.code(409).send(nodeError("node_mode_disabled", "Multi-node deployment is not enabled"));
    }
    if (!listExecutableNodeIds(appConfig.node).includes(id)) {
      return reply.code(404).send(nodeError("node_not_found", "Node is not configured"));
    }
    if (id === appConfig.node.id) {
      return { nodeId: id, reachable: true, authenticated: null, latencyMs: 0, checkedAt: Date.now(), errorCode: null } satisfies NodeCheckResult;
    }
    let pending = pendingChecks.get(id);
    if (!pending) {
      pending = checkPeer(id).finally(() => pendingChecks.delete(id));
      pendingChecks.set(id, pending);
    }
    return pending;
  });
}
