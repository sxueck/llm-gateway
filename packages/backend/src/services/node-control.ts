import type { FastifyInstance } from "fastify";
import type { NodeConfig } from "../config/node.js";

/**
 * 控制节点判定与路由守卫。
 *
 * 单节点（未启用多节点模式）始终视为控制节点，行为与既有部署完全一致；
 * 启用后仅 controlId 指向的节点承担管理面。
 */
export function isControlNode(config: NodeConfig): boolean {
  return !config.enabled || config.id === config.controlId;
}

/** 非控制节点禁用的路径前缀（精确匹配前缀或其子路径）。 */
const GUARDED_PREFIXES = [
  "/api/admin",
  "/api/auth",
  "/api/agent",
  "/api/internal/agent",
] as const;

export function isGuardedNodePath(path: string): boolean {
  const pathname = path.split("?", 1)[0];
  return GUARDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * 在所有路由之前注册 onRequest 守卫：非控制节点对管理/Agent 路径
 * 一律直接返回 503（OpenAI 错误 envelope，code=control_node_required），
 * 不重定向、不重试。控制节点（含未启用多节点模式的单节点）不注册任何钩子。
 *
 * 注意：必须在任何路由（包括 /api/admin/config/debug-stream）注册之前
 * 调用，否则先注册的路由不会经过该守卫。
 */
export function registerNodeControlGuard(
  fastify: FastifyInstance,
  config: NodeConfig,
): void {
  if (isControlNode(config)) {
    return;
  }

  fastify.addHook("onRequest", async (request, reply) => {
    if (!isGuardedNodePath(request.url)) {
      return;
    }

    return reply.code(503).send({
      error: {
        message:
          "该请求需要控制节点 (control node) 处理，当前节点不提供此能力",
        type: "invalid_request_error",
        param: null,
        code: "control_node_required",
      },
    });
  });
}
