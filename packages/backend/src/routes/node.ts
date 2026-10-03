import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { appConfig } from '../config/index.js';
import { modelDb, providerDb, virtualKeyDb } from '../db/index.js';
import { buildProviderConfig } from './proxy/provider-config-builder.js';
import { createOpenAIProxyHandler } from './openai/proxy-handler.js';
import { createDecisionsProxyHandler } from './openai/decisions-handler.js';
import { createAnthropicProxyHandler } from './anthropic/proxy-handler.js';
import { createGeminiProxyHandler } from './gemini/proxy-handler.js';
import { runResponsesTransport } from '../services/responses-transport/orchestrator.js';
import { resolveTransportMode } from '../services/responses-transport/mode-resolver.js';
import type { ResponsesStreamResult } from '../services/responses-transport/types.js';
import { logApiRequestAsync } from '../services/api-request-logger.js';
import { handleNodeOperation } from '../services/node-operations.js';
import { CLIENT_ABORTED_MESSAGE } from '../utils/client-abort.js';
import { nodeAuditContext } from '../services/node-audit.js';
import { circuitBreaker, httpFailureError } from '../services/circuit-breaker.js';
import { AGENT_LOOPBACK_HEADER, AGENT_RUN_ID_HEADER, agentLoopbackToken } from '../agent/run/loopback-token.js';
import {
  NODE_DISPATCH_PATH,
  NODE_EPOCH_PATH,
  NODE_BOOT_EPOCH,
  getNodeRequestState,
  isAllowedDispatchPath,
  isNodeLedgerSaturated,
  nodeEnvelopeSchema,
  nodeError,
  providerOwner,
  setNodeRequestState,
  verifyNodeEnvelope,
} from '../services/node-dispatch.js';

async function executeResponsesTurn(request: FastifyRequest, reply: FastifyReply) {
  const state = getNodeRequestState(request)!;
  const { virtualKey, virtualKeyValue } = state.preflight;
  const { provider, providerId, currentModel } = state.modelResult;
  const circuitKey = state.modelResult.circuitBreakerKey || providerId;
  if (!circuitBreaker.isAvailable(circuitKey)) {
    return reply.code(503).send(nodeError('owner_circuit_open', 'Provider circuit is open on its owner node'));
  }
  const config = await buildProviderConfig(provider, virtualKey, virtualKeyValue, providerId, request, currentModel, 'openai');
  if ('code' in config) return reply.code(config.code).send(config.body);
  const { protocolConfig } = config;
  const controller = new AbortController();
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.once('close', onClose);
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  const startedAt = Date.now();
  async function* events() {
    let result: ResponsesStreamResult | undefined;
    let errorMessage: string | undefined;
    let upstreamError: unknown;
    try {
      const mode = resolveTransportMode(true, protocolConfig.upstreamTransport ?? 'http_sse');
      for await (const event of runResponsesTransport(mode, protocolConfig, { body: request.body as Record<string, unknown>, stream: true }, controller.signal)) {
        if ((event as any).__result) result = (event as any).__result;
        yield `${JSON.stringify(event)}\n`;
      }
    } catch (error) {
      upstreamError = error;
      errorMessage = controller.signal.aborted ? CLIENT_ABORTED_MESSAGE : 'Upstream response failed';
      throw new Error(errorMessage);
    } finally {
      clearTimeout(timer);
      reply.raw.off('close', onClose);
      if (controller.signal.aborted) errorMessage = CLIENT_ABORTED_MESSAGE;
      if (controller.signal.aborted) circuitBreaker.recordFailure(circuitKey, httpFailureError(499, CLIENT_ABORTED_MESSAGE));
      else if (upstreamError) circuitBreaker.recordFailure(circuitKey, upstreamError);
      else if (result?.terminalEventReceived) circuitBreaker.recordSuccess(circuitKey);
      else circuitBreaker.recordFailure(circuitKey, httpFailureError(502, 'Upstream stream ended without a terminal event'));
      logApiRequestAsync({
        virtualKey,
        providerId,
        model: protocolConfig.model || 'unknown',
        tokenCount: result?.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cachedTokens: result?.tokenUsage.cachedTokens,
        status: result?.terminalEventReceived && !errorMessage ? 'success' : 'error',
        responseTime: Date.now() - startedAt,
        tffbMs: result?.tffbMs,
        errorMessage,
        requestType: 'openai-responses-ws',
        ip: state.preflight.requestIp,
        userAgent: state.preflight.requestUserAgent,
        request,
      });
    }
  }
  reply.header('content-type', 'application/x-ndjson');
  return reply.send(Readable.from(events()));
}

export async function nodeRoutes(
  fastify: FastifyInstance,
  opts: FastifyPluginOptions & { isLedgerSaturated?: () => boolean } = {},
) {
  const isLedgerSaturated = opts.isLedgerSaturated ?? isNodeLedgerSaturated;
  const handlers = {
    openai: createOpenAIProxyHandler(),
    anthropic: createAnthropicProxyHandler(),
    gemini: createGeminiProxyHandler(),
  };
  const decisions = createDecisionsProxyHandler();
  fastify.get(NODE_EPOCH_PATH, (_request, reply) => {
    if (!appConfig.node.enabled) return reply.code(404).send(nodeError('node_mode_disabled', 'node mode is disabled'));
    return reply.header('cache-control', 'no-store').send({ nodeId: appConfig.node.id, epoch: NODE_BOOT_EPOCH });
  });
  // Reserve envelope overhead above the public API's 10 MiB body limit.
  fastify.post(NODE_DISPATCH_PATH, { bodyLimit: 11 * 1024 * 1024 }, async (request, reply) => {
    // Capacity is not authentication: answering 401 here would make the sender drop its
    // cached peer epoch and re-handshake on every dispatch, amplifying the overload.
    if (isLedgerSaturated()) {
      return reply.code(503).header('retry-after', '5').send(
        nodeError('node_dispatch_saturated', 'Owner node replay ledger is saturated; retry shortly'),
      );
    }
    const serialized = JSON.stringify(request.body);
    const source = verifyNodeEnvelope(appConfig.node, request.headers, serialized);
    if (!source) return reply.header('x-gateway-node-auth-failed', '1').code(401).send(nodeError('invalid_node_auth', 'Invalid node authentication'));
    if (await handleNodeOperation(source, request.body, reply)) return reply;
    const parsed = nodeEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(nodeError('invalid_node_dispatch', 'Invalid node dispatch envelope'));
    const envelope = parsed.data;
    if (!isAllowedDispatchPath(envelope.protocol, envelope.transport, envelope.url) ||
        envelope.hops.at(-1) !== source || envelope.ingressNode !== envelope.hops[0] ||
        Date.now() - envelope.startedAt > 10 * 60_000 || envelope.startedAt > Date.now() + 60_000) {
      return reply.code(400).send(nodeError('invalid_node_dispatch', 'Invalid node dispatch path or hop chain'));
    }
    // Clock skew must not grant a peer more than a local ten-second retry window.
    envelope.startedAt = Math.min(envelope.startedAt, Date.now());
    const provider = await providerDb.getById(envelope.resolution.providerId);
    if (!provider || !provider.enabled) return reply.code(503).send(nodeError('provider_unavailable', 'Provider is unavailable'));
    if (providerOwner(provider) !== appConfig.node.id) {
      return reply.code(409).send(nodeError('owner_node_mismatch', 'Provider ownership changed; dispatch will not be forwarded'));
    }
    const virtualKey = await virtualKeyDb.getById(envelope.virtualKeyId);
    if (!virtualKey || !virtualKey.enabled) return reply.code(403).send(nodeError('api_key_disabled', 'Virtual key is unavailable'));
    const currentModel = envelope.resolution.currentModelId ? await modelDb.getById(envelope.resolution.currentModelId) : undefined;
    if (envelope.resolution.currentModelId && !currentModel) {
      return reply.code(409).send(nodeError('model_unavailable', 'Selected model no longer exists'));
    }
    const { currentModelId: _currentModelId, excludeTargetKeys, ...resolution } = envelope.resolution;
    const headers: Record<string, string> = { ...envelope.headers, authorization: `Bearer ${virtualKey.key_value}` };
    if (envelope.clientIp) headers['x-forwarded-for'] = envelope.clientIp;
    if (envelope.agentRunId) {
      headers[AGENT_LOOPBACK_HEADER] = agentLoopbackToken();
      headers[AGENT_RUN_ID_HEADER] = envelope.agentRunId;
    }
    // Only a verified peer can install this state; public headers cannot skip auth, RPM or routing.
    setNodeRequestState(request, {
      envelope,
      preflight: {
        requestIp: envelope.clientIp || envelope.headers['x-forwarded-for'] || envelope.headers['x-real-ip'] || request.ip,
        requestUserAgent: envelope.headers['user-agent'] || '',
        virtualKey,
        virtualKeyValue: virtualKey.key_value,
        resolvedAuthHeader: headers.authorization,
      },
      modelResult: { ...resolution, routeInfo: resolution.routeInfo as any, provider, currentModel, excludeTargetKeys: excludeTargetKeys ? new Set(excludeTargetKeys) : undefined },
    });
    request.raw.url = envelope.url;
    request.raw.method = envelope.method;
    request.raw.headers = headers;
    request.body = envelope.body;
    reply.header('x-gateway-execution-node', appConfig.node.id);
    return nodeAuditContext.run({ requestId: envelope.requestId, ingressNode: envelope.ingressNode, executionNode: appConfig.node.id }, async () => {
      if (envelope.transport === 'responses-ws') return executeResponsesTurn(request, reply);
      if (envelope.url.split('?')[0] === '/v1/systemone') return decisions(request, reply);
      return handlers[envelope.protocol](request, reply);
    });
  });
}
