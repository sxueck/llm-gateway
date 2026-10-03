import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { Agent, fetch as peerFetch } from 'undici';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appConfig } from '../config/index.js';
import type { NodeConfig } from '../config/node.js';
import type { ModelResolutionResult } from '../routes/proxy/model-resolver.js';
import type { ProxyPreflightContext, ProxyProtocol } from '../routes/proxy/pipeline.js';
import type { ResponsesServerEvent } from './responses-transport/types.js';
import { agentRunIdFromHeaders } from '../agent/run/loopback-token.js';
import { extractIp } from '../utils/ip.js';
import { memoryLogger } from './logger.js';

export const NODE_DISPATCH_PATH = '/api/internal/node/dispatch';
export const NODE_EPOCH_PATH = '/api/internal/node/epoch';
export const NODE_BOOT_EPOCH = randomUUID();
const peerEpochs = new Map<string, { epoch: string; expiresAt: number }>();
const MAX_HOPS = 8;
const SIGNATURE_WINDOW_MS = 60_000;
const MAX_NONCES = 20_000;
const MAX_DURATION_MS = 10 * 60_000;
// Non-stream replies may generate for minutes before sending any headers.
const peerAgent = new Agent({ connect: { timeout: 5_000 }, headersTimeout: MAX_DURATION_MS, bodyTimeout: 0 });
const nonces = new Map<string, number>();
const states = new WeakMap<FastifyRequest, NodeRequestState>();
const hopHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'content-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'authorization', 'x-api-key', 'x-goog-api-key', 'x-google-api-key', 'cookie', 'set-cookie']);

const resolutionSchema = z.object({
  providerId: z.string().min(1).max(256),
  currentModelId: z.string().max(256).optional(),
  modelId: z.string().max(256).optional(),
  circuitBreakerKey: z.string().max(512).optional(),
  canRetry: z.boolean().optional(),
  excludeTargetKeys: z.array(z.string().max(512)).max(1000).optional(),
  forcedReasoningEffort: z.string().max(64).optional(),
  routeInfo: z.record(z.unknown()).optional(),
});

export const nodeEnvelopeSchema = z.object({
  protocol: z.enum(['openai', 'anthropic', 'gemini']),
  transport: z.enum(['http', 'responses-ws']),
  url: z.string().max(4096),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  headers: z.record(z.string().max(16384)),
  body: z.unknown(),
  virtualKeyId: z.string().min(1).max(256),
  agentRunId: z.string().min(1).max(255).optional(),
  clientIp: z.string().max(128).optional(),
  resolution: resolutionSchema,
  logicalCacheKey: z.string().max(256).nullable().optional(),
  normalized: z.boolean().default(false),
  startedAt: z.number().int().positive(),
  ingressNode: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  requestId: z.string().max(128),
  hops: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).min(1).max(MAX_HOPS),
}).strict();

export type NodeEnvelope = z.infer<typeof nodeEnvelopeSchema>;
export interface NodeRequestState {
  envelope: NodeEnvelope;
  preflight: ProxyPreflightContext;
  modelResult: ModelResolutionResult;
  ownerAdmitted?: boolean;
}

export function getNodeRequestState(request: FastifyRequest): NodeRequestState | undefined {
  return states.get(request);
}

export function setNodeRequestState(request: FastifyRequest, state: NodeRequestState): void {
  states.set(request, state);
}

export function providerOwner(provider: { owner_node?: string | null }, config = appConfig.node): string {
  return provider.owner_node || (config.enabled ? config.controlId : config.id);
}

export function isRemoteProvider(provider: { owner_node?: string | null }, config = appConfig.node): boolean {
  // An explicit owner must never silently become local when node mode is disabled.
  return providerOwner(provider, config) !== config.id;
}

export function nodeError(code: string, message: string) {
  return { error: { message, type: 'api_error', param: null, code } };
}

function signature(config: NodeConfig, source: string, timestamp: string, nonce: string, epoch: string, serialized: string): string {
  return createHmac('sha256', config.secret)
    .update(JSON.stringify([NODE_DISPATCH_PATH, source, config.id, timestamp, nonce, epoch, serialized]))
    .digest('hex');
}

export function signNodeEnvelope(config: NodeConfig, destination: string, serialized: string, now = Date.now(), nonce: string = randomUUID(), epoch: string = NODE_BOOT_EPOCH): Record<string, string> {
  const timestamp = String(now);
  return {
    'content-type': 'application/json',
    'x-gateway-node-source': config.id,
    'x-gateway-node-timestamp': timestamp,
    'x-gateway-node-nonce': nonce,
    'x-gateway-node-epoch': epoch,
    'x-gateway-node-signature': signature({ ...config, id: destination }, config.id, timestamp, nonce, epoch, serialized),
  };
}

function pruneNonces(seen: Map<string, number>, now: number): void {
  for (const [key, expiry] of seen) {
    if (expiry <= now) seen.delete(key);
  }
}

/**
 * Replay ledger 已满：无法记录新 nonce，又不能淘汰仍在接受窗口内的记录。
 * 这是容量状态而非认证失败，调用方必须区分二者。
 */
export function isNodeLedgerSaturated(now = Date.now(), seen = nonces): boolean {
  pruneNonces(seen, now);
  return seen.size >= MAX_NONCES;
}

export function verifyNodeEnvelope(config: NodeConfig, headers: Record<string, unknown>, serialized: string, now = Date.now(), seen = nonces, bootEpoch: string = NODE_BOOT_EPOCH): string | null {
  const source = headers['x-gateway-node-source'];
  const timestamp = headers['x-gateway-node-timestamp'];
  const nonce = headers['x-gateway-node-nonce'];
  const supplied = headers['x-gateway-node-signature'];
  const epoch = headers['x-gateway-node-epoch'];
  if (epoch !== bootEpoch) return null;
  if (!config.enabled || typeof source !== 'string' || !Object.hasOwn(config.peers, source) ||
      typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS ||
      typeof nonce !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(nonce) ||
      typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return null;
  const expected = signature(config, source, timestamp, nonce, bootEpoch, serialized);
  if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) return null;
  pruneNonces(seen, now);
  const key = `${source}:${nonce}`;
  // Do not evict live nonces: doing so would permit replay during the acceptance window.
  if (seen.has(key) || seen.size >= MAX_NONCES) return null;
  seen.set(key, Number(timestamp) + SIGNATURE_WINDOW_MS + 1);
  return source;
}

export function isAllowedDispatchPath(protocol: ProxyProtocol, transport: NodeEnvelope['transport'], url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//') || /[\r\n\\#]/.test(url)) return false;
  const path = url.split('?')[0];
  if (transport === 'responses-ws') return protocol === 'openai' && /^\/(v1\/)?responses$/.test(path);
  if (protocol === 'anthropic') return /^\/(v1\/)?messages$/.test(path);
  if (protocol === 'gemini') return /^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(path);
  return /^\/(v1\/)?(chat\/completions|responses(?:\/compact)?|completions|embeddings|moderations|images\/[^/]+|audio\/[^/]+)$/.test(path) || path === '/v1/systemone';
}

export function filterNodeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const connection = typeof headers.connection === 'string' ? headers.connection.toLowerCase().split(',').map(value => value.trim()) : [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (hopHeaders.has(lower) || connection.includes(lower) || lower.startsWith('x-gateway-node-') || lower.startsWith('x-agent-') || /[\r\n]/.test(name)) continue;
    if (typeof value === 'string' && !/[\r\n]/.test(value)) result[lower] = value;
  }
  return result;
}

export function makeNodeEnvelope(request: FastifyRequest, protocol: ProxyProtocol, virtualKey: any, modelResult: ModelResolutionResult, options: { transport?: NodeEnvelope['transport']; logicalCacheKey?: string | null; normalized?: boolean; startedAt?: number } = {}): NodeEnvelope {
  const prior = getNodeRequestState(request)?.envelope;
  return {
    protocol,
    transport: options.transport || 'http',
    url: request.url,
    method: request.method as NodeEnvelope['method'],
    headers: filterNodeHeaders(request.headers),
    body: request.body,
    virtualKeyId: virtualKey.id,
    agentRunId: agentRunIdFromHeaders(request.headers) ?? prior?.agentRunId,
    clientIp: prior?.clientIp ?? extractIp(request),
    resolution: {
      providerId: modelResult.providerId,
      currentModelId: modelResult.currentModel?.id,
      modelId: modelResult.modelId,
      circuitBreakerKey: modelResult.circuitBreakerKey,
      canRetry: modelResult.canRetry,
      excludeTargetKeys: modelResult.excludeTargetKeys ? [...modelResult.excludeTargetKeys] : undefined,
      forcedReasoningEffort: modelResult.forcedReasoningEffort,
      routeInfo: modelResult.routeInfo as any,
    },
    logicalCacheKey: options.logicalCacheKey ?? prior?.logicalCacheKey,
    normalized: options.normalized ?? false,
    startedAt: options.startedAt ?? prior?.startedAt ?? Date.now(),
    ingressNode: prior?.ingressNode ?? appConfig.node.id,
    requestId: prior?.requestId ?? randomUUID(),
    hops: [...(prior?.hops ?? []), appConfig.node.id],
  };
}

export async function fetchOwner(owner: string, envelope: NodeEnvelope, signal: AbortSignal, config = appConfig.node) {
  if (!config.enabled || !Object.hasOwn(config.peers, owner)) throw new Error('owner_node_unconfigured');
  nodeEnvelopeSchema.parse(envelope);
  if (!isAllowedDispatchPath(envelope.protocol, envelope.transport, envelope.url)) throw new Error('node_dispatch_path_invalid');
  return fetchNodePayload(owner, envelope, signal, config);
}

export async function fetchNodePayload(owner: string, payload: unknown, signal: AbortSignal, config = appConfig.node) {
  if (!config.enabled || !Object.hasOwn(config.peers, owner)) throw new Error('owner_node_unconfigured');
  const serialized = JSON.stringify(payload);
  const cacheKey = `${owner}|${config.peers[owner]}`;
  let cached = peerEpochs.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    const response = await peerFetch(`${config.peers[owner]}${NODE_EPOCH_PATH}`, { signal, dispatcher: peerAgent, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('owner_node_unavailable'); }
    const data = z.object({ nodeId: z.literal(owner), epoch: z.string().uuid() }).parse(await response.json());
    cached = { epoch: data.epoch, expiresAt: Date.now() + 5_000 };
    peerEpochs.set(cacheKey, cached);
  }
  // Binding to the receiver boot epoch prevents replay after its in-memory ledger resets.
  const response = await peerFetch(`${config.peers[owner]}${NODE_DISPATCH_PATH}`, {
    method: 'POST',
    headers: signNodeEnvelope(config, owner, serialized, Date.now(), randomUUID(), cached.epoch),
    body: serialized,
    signal,
    dispatcher: peerAgent,
    redirect: 'error',
  });
  if (response.status === 401 && response.headers.get('x-gateway-node-auth-failed') === '1') {
    peerEpochs.delete(cacheKey);
    await response.body?.cancel();
    throw new Error('peer_node_auth_failed');
  }
  return response;
}

export async function forwardToOwner(request: FastifyRequest, reply: FastifyReply, protocol: ProxyProtocol, virtualKey: any, modelResult: ModelResolutionResult, options: Parameters<typeof makeNodeEnvelope>[4] = {}): Promise<boolean> {
  if (!isRemoteProvider(modelResult.provider)) return false;
  const owner = providerOwner(modelResult.provider);
  const controller = new AbortController();
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.once('close', onClose);
  const timer = setTimeout(() => controller.abort(), MAX_DURATION_MS);
  const cleanup = () => { clearTimeout(timer); reply.raw.off('close', onClose); };
  try {
    const response = await fetchOwner(owner, makeNodeEnvelope(request, protocol, virtualKey, modelResult, options), controller.signal);
    // A retry must not retain the failed target's cap or routing-exposure headers.
    for (const name of new Set([...Object.keys(reply.getHeaders()), ...reply.raw.getHeaderNames()])) {
      if (name.toLowerCase().startsWith('x-gateway-') || name.toLowerCase() === 'x-max-completion-tokens') {
        reply.removeHeader(name);
        reply.raw.removeHeader(name);
      }
    }
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      if (!hopHeaders.has(name) && name !== 'content-length') reply.header(name, value);
    });
    reply.header('x-gateway-execution-node', owner);
    if (!response.body) {
      cleanup();
      reply.send();
      return true;
    }
    const stream = Readable.fromWeb(response.body as any);
    stream.once('close', cleanup);
    stream.once('error', () => controller.abort());
    reply.send(stream);
    // Fastify async handlers must stay pending until the streamed reply finishes.
    await reply;
    return true;
  } catch (error) {
    cleanup();
    const code = error instanceof z.ZodError ? 'node_dispatch_invalid'
      : error instanceof Error && ['owner_node_unconfigured', 'node_dispatch_path_invalid', 'peer_node_auth_failed'].includes(error.message) ? error.message
      : 'owner_node_unavailable';
    memoryLogger.warn(`node dispatch failed | owner=${owner} | code=${code}`, 'NodeDispatch');
    if (!reply.raw.headersSent && !reply.raw.destroyed) {
      reply.code(503).send(nodeError(code, `Provider owner node '${owner}' could not execute this dispatch; takeover is disabled`));
    }
    return true;
  }
}

export async function* remoteResponsesEvents(request: FastifyRequest, virtualKey: any, modelResult: ModelResolutionResult, body: any, signal: AbortSignal): AsyncGenerator<ResponsesServerEvent> {
  const turnRequest = { ...request, url: request.url, method: 'POST', headers: request.headers, id: request.id, body } as FastifyRequest;
  const envelope = makeNodeEnvelope(turnRequest, 'openai', virtualKey, modelResult, { transport: 'responses-ws' });
  const response = await fetchOwner(providerOwner(modelResult.provider), envelope, signal);
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    await response.body?.cancel();
    throw new Error('owner_node_unavailable');
  }
  let pending = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > 10 * 1024 * 1024) throw new Error('node_event_too_large');
        if (line) yield JSON.parse(line);
      }
      if (pending.length > 10 * 1024 * 1024) throw new Error('node_event_too_large');
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error('node_stream_truncated');
  } finally {
    if (!signal.aborted) await response.body.cancel().catch(() => {});
  }
}
