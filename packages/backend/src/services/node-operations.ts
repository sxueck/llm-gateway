import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { appConfig } from '../config/index.js';
import { providerDb } from '../db/index.js';
import { buildModelsEndpoint } from '../utils/api-endpoint-builder.js';
import { decryptApiKey } from '../utils/crypto.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';
import { isPrivateNodeOrigin } from '../utils/node-origin.js';
import { fetchNodePayload, nodeError, providerOwner } from './node-dispatch.js';
import { probeModelViaProviderLocal, type ModelProbeResult } from './probe-service.js';

/**
 * 管理类节点操作（admin operations）。
 *
 * 由控制节点（管理后台所在节点）发起，经 /api/internal/node/dispatch 的
 * HMAC 签名通道下发到目标 owner 节点执行；owner 节点只信任经过
 * verifyNodeEnvelope 认证、且 source === controlId 的请求。
 */

// ---------------------------------------------------------------------------
// 从 routes/providers.ts 抽出的本地执行助手（管理路由与节点操作共用，避免双份逻辑）
// ---------------------------------------------------------------------------

export interface ProviderTestResult {
  success: boolean;
  status?: number;
  message: string;
  latencyMs?: number;
}

export interface FetchModelsResult {
  success: boolean;
  message: string;
  models: Array<Record<string, unknown>>;
}

const PROVIDER_TEST_TIMEOUT_MS = 5000;
const FETCH_MODELS_TIMEOUT_MS = 10000;
const inFlightProviderTests = new Map<string, Promise<ProviderTestResult>>();

// Preserve upstream model entries as-is (max_completion_tokens, context_length, ...)
// so capability metadata survives into the admin UI; only id/name are normalized.
export function mapUpstreamModelList(data: any): Array<Record<string, unknown>> {
  return (
    data?.data?.map((model: any) => ({
      ...model,
      id: model.id,
      name: model.id,
    })) || []
  );
}

function resolvePort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === 'https:' ? 443 : 80;
}

async function tcpConnectLatency(
  hostOrIp: string,
  port: number,
  timeoutMs: number,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = createConnection({ host: hostOrIp, port });
    let settled = false;

    const finish = (success: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - started;
      socket.destroy();
      resolve({ success, latencyMs, error: error?.message });
    };

    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(false, err));
    socket.setTimeout(timeoutMs, () =>
      finish(false, new Error(`连接超时 (${timeoutMs}ms)`)),
    );
  });
}

async function testProviderTcpOnly(baseUrl: string): Promise<ProviderTestResult> {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname;
    const port = resolvePort(url);

    // DNS 解析放在计时外，保证 latencyMs 仅反映 TCP connect 时长。
    const resolved = await lookup(host);
    const latency = await tcpConnectLatency(
      resolved.address,
      port,
      PROVIDER_TEST_TIMEOUT_MS,
    );

    return {
      success: latency.success,
      status: latency.success ? 200 : undefined,
      message: latency.success ? '网络连通' : latency.error || '连接失败',
      latencyMs: latency.latencyMs,
    };
  } catch (error: any) {
    return {
      success: false,
      message: error?.message || '连接失败',
    };
  }
}

function getOrCreateProviderTest(
  providerId: string,
  baseUrl: string,
): Promise<ProviderTestResult> {
  const inFlight = inFlightProviderTests.get(providerId);
  if (inFlight) {
    return inFlight;
  }

  const task = testProviderTcpOnly(baseUrl).finally(() => {
    inFlightProviderTests.delete(providerId);
  });

  inFlightProviderTests.set(providerId, task);
  return task;
}

/** 在本节点执行提供商连通性测试（仅限 owner 是本节点的提供商）。 */
export async function executeProviderTestLocally(
  providerId: string,
  baseUrl: string,
): Promise<ProviderTestResult> {
  return getOrCreateProviderTest(providerId, baseUrl);
}

/** 在本节点拉取上游模型列表（仅限 owner 是本节点的目标）。 */
export async function fetchUpstreamModelsLocally(
  baseUrl: string,
  apiKey: string,
): Promise<FetchModelsResult> {
  try {
    const endpoint = buildModelsEndpoint(baseUrl);

    const response = await upstreamFetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      timeoutMs: FETCH_MODELS_TIMEOUT_MS,
    });

    if (!response.ok) {
      return {
        success: false,
        message: `获取模型列表失败: HTTP ${response.status}`,
        models: [],
      };
    }

    const data: any = await response.json();
    const models = mapUpstreamModelList(data);

    return {
      success: true,
      message: `成功获取 ${models.length} 个模型`,
      models,
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || '获取模型列表失败',
      models: [],
    };
  }
}

// ---------------------------------------------------------------------------
// 操作协议：严格判别联合，字段超集一律视为"非操作"交回常规 dispatch 处理
// ---------------------------------------------------------------------------

const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const nodeOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('node-health') }).strict(),
  z
    .object({
      op: z.literal('provider-test'),
      providerId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      op: z.literal('fetch-models'),
      ownerNode: z.string().regex(NODE_ID_PATTERN),
      baseUrl: z.string().url().max(2048),
      apiKey: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      op: z.literal('model-probe'),
      providerId: z.string().min(1).max(256),
      modelIdentifier: z.string().min(1).max(512),
      protocol: z.enum(['openai', 'anthropic', 'google']).nullish(),
      prompt: z.string().max(4096).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
    })
    .strict(),
]);

export type NodeOperation = z.infer<typeof nodeOperationSchema>;

function refuseOwnershipChange(reply: FastifyReply): FastifyReply {
  // 归属校验失败绝不回弹到其他节点，也不在本节点代为执行。
  return reply.code(409).send(
    nodeError(
      'owner_node_mismatch',
      'Provider ownership changed; administrative operation will not be executed or forwarded',
    ),
  );
}

/**
 * owner 节点侧的管理操作入口（由 routes/node.ts 在 节点签名认证通过后调用）。
 *
 * 返回 false 表示载荷不是管理操作（由调用方继续按 dispatch envelope 处理）；
 * 返回 true 表示已接管并完成响应。仅认证过的控制节点可发起；操作载荷
 * 可能包含上游凭据（fetch-models），任何分支都不得记录或回显载荷。
 */
export async function handleNodeOperation(
  source: string,
  payload: unknown,
  reply: FastifyReply,
): Promise<boolean> {
  const parsed = nodeOperationSchema.safeParse(payload);
  if (!parsed.success) return false;
  const operation = parsed.data;
  try {
    if (!appConfig.node.enabled || source !== appConfig.node.controlId) {
      reply.code(403).send(
        nodeError(
          'node_operation_forbidden',
          'Administrative node operations may only be initiated by the control node',
        ),
      );
      return true;
    }
    switch (operation.op) {
      case 'node-health': {
        reply.code(200).send({ enabled: true, nodeId: appConfig.node.id, controlId: appConfig.node.controlId });
        return true;
      }
      case 'provider-test': {
        const provider = await providerDb.getById(operation.providerId);
        if (!provider) {
          reply.code(404).send(nodeError('provider_not_found', '提供商不存在'));
          return true;
        }
        // 测试前用最新库中归属做校验；仅携带 providerId，密钥永不出库。
        if (providerOwner(provider) !== appConfig.node.id) {
          refuseOwnershipChange(reply);
          return true;
        }
        reply.code(200).send(
          await executeProviderTestLocally(provider.id, provider.base_url),
        );
        return true;
      }
      case 'fetch-models': {
        // 未落盘的 baseUrl/apiKey 只允许在请求指定的 owner（即本节点）上使用。
        if (operation.ownerNode !== appConfig.node.id) {
          refuseOwnershipChange(reply);
          return true;
        }
        reply.code(200).send(
          await fetchUpstreamModelsLocally(operation.baseUrl, operation.apiKey),
        );
        return true;
      }
      case 'model-probe': {
        const provider = await providerDb.getById(operation.providerId);
        if (!provider) {
          reply.code(404).send(nodeError('provider_not_found', '提供商不存在'));
          return true;
        }
        if (providerOwner(provider) !== appConfig.node.id) {
          refuseOwnershipChange(reply);
          return true;
        }
        // 密钥在 owner 节点本地解密，探测请求不携带密钥。
        const result = await probeModelViaProviderLocal({
          modelIdentifier: operation.modelIdentifier,
          protocol: operation.protocol ?? null,
          provider,
          apiKey: decryptApiKey(provider.api_key),
          prompt: operation.prompt ?? '测试',
          timeoutMs: operation.timeoutMs ?? 30000,
        });
        reply.code(200).send(result);
        return true;
      }
    }
  } catch {
    // 不记录载荷（可能含 apiKey/baseUrl），错误信息保持通用。
    reply.code(500).send(nodeError('node_operation_failed', 'Administrative node operation failed'));
    return true;
  }
}

// ---------------------------------------------------------------------------
// 控制节点侧转发助手（目标 owner 只来自 appConfig.node.peers，不接受任意 URL）
// ---------------------------------------------------------------------------

export interface NodeOperationForwardOutcome {
  status: number;
  body: unknown;
}

/** 将管理操作转发给 owner 节点，返回其状态码与响应体（供管理路由原样透传）。 */
export async function forwardNodeOperation(
  owner: string,
  operation: NodeOperation,
  timeoutMs: number,
): Promise<NodeOperationForwardOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchNodePayload(owner, operation, controller.signal);
    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // 非 JSON 响应体原样透传
      }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 转发并镜像 owner 的状态码/响应体；任何失败都不得回退为本地执行。 */
export async function forwardNodeOperationReply(
  reply: FastifyReply,
  owner: string,
  operation: NodeOperation,
  timeoutMs: number,
): Promise<FastifyReply> {
  try {
    const outcome = await forwardNodeOperation(owner, operation, timeoutMs);
    return reply.code(outcome.status).send(outcome.body);
  } catch {
    return reply.code(503).send(
      nodeError(
        'owner_node_unavailable',
        `Provider owner node '${owner}' is unavailable; takeover is disabled`,
      ),
    );
  }
}

/**
 * 携带未落盘 apiKey 的操作（fetch-models）只允许经加密（https）或
 * 环回/内网地址的节点通道传输，避免明文凭据跨公网转发。
 */
export function isPrivateNodeTransport(owner: string, config = appConfig.node): boolean {
  return Object.hasOwn(config.peers, owner) && isPrivateNodeOrigin(config.peers[owner]);
}

export type { ModelProbeResult };
