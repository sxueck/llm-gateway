import type { FastifyReply, FastifyRequest } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { extractVirtualKeyAuthHeader, authenticateVirtualKey } from './auth.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import { resolveModelAndProvider, retrySmartRouting } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';
import { appConfig } from '../../config/index.js';
import { providerDb } from '../../db/index.js';
import { computeLogicalCacheKey } from './cache.js';
import { shouldBypassGatewayCache } from '../../utils/path-detector.js';
import { forwardToOwner, getNodeRequestState, isRemoteProvider, nodeError } from '../../services/node-dispatch.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';

export type ProxyProtocol = 'openai' | 'anthropic' | 'gemini';

export interface ProxyPipelineContext {
  requestIp: string;
  requestUserAgent: string;
  resolvedAuthHeader?: string;
  virtualKey: any;
  virtualKeyValue: string;
  provider: any;
  providerId: string;
  currentModel?: any;
  modelResult: any;
  configResult: any;
}

export interface ProxyPreflightContext {
  requestIp: string;
  requestUserAgent: string;
  resolvedAuthHeader?: string;
  virtualKey: any;
  virtualKeyValue: string;
}

export interface ProxyPreflightHandlers {
  onAntiBotBlock: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    reason?: string;
  }) => Promise<void> | void;
  onAuthError: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    authError: any;
  }) => Promise<void> | void;
  onRateLimited: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    /** RPM limit configured on virtual_keys.rate_limit. */
    limitPerMinute: number;
    retryAfterSeconds: number;
  }) => Promise<void> | void;
}

export interface ProxyPipelineHandlers extends ProxyPreflightHandlers {
  onModelError: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    virtualKey: any;
    virtualKeyValue: string;
    modelError: any;
  }) => Promise<void> | void;
  onProviderConfigError: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    virtualKey: any;
    virtualKeyValue: string;
    providerId: string;
    providerConfigError: any;
  }) => Promise<void> | void;
}

export interface ProxyAfterAuthArgs {
  request: FastifyRequest;
  reply: FastifyReply;
  requestIp: string;
  requestUserAgent: string;
  virtualKey: any;
  virtualKeyValue: string;
  /**
   * Out-param: the entrypoint derives the logical response-cache key here, from the
   * body after image compression but before routing rewrites it. The pipeline reads it
   * back for the cross-node envelope instead of hashing the whole body a second time.
   */
  logicalCacheKey?: string | null;
}

export interface ProxyPipelineOptions {
  protocol: ProxyProtocol;
  handlers: ProxyPipelineHandlers;
  // Runs after auth succeeds and before model/provider resolution.
  // Return false if the hook already sent a response and the pipeline should stop.
  afterAuth?: (args: ProxyAfterAuthArgs) => Promise<boolean | void> | boolean | void;
}

export type ProxyPipelineResult =
  | { ok: true; context: ProxyPipelineContext }
  | { ok: false };

export type ProxyPreflightResult =
  | { ok: true; context: ProxyPreflightContext }
  | { ok: false };

export async function runProxyAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
  handlers: Pick<ProxyPreflightHandlers, 'onAntiBotBlock' | 'onAuthError'>
): Promise<ProxyPreflightResult> {
  const requestIp = extractIp(request);
  const requestUserAgent = getRequestUserAgent(request);

  const { antiBotService } = await import('../../services/anti-bot.js');
  const antiBotResult = antiBotService.detect(requestUserAgent, requestIp);
  antiBotService.logDetection(requestUserAgent, antiBotResult, requestIp, request.headers);
  if (antiBotResult.shouldBlock) {
    memoryLogger.warn(
      `拦截爬虫/威胁IP请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${antiBotResult.reason}`,
      'AntiBot'
    );
    await handlers.onAntiBotBlock({
      reply,
      requestIp,
      requestUserAgent,
      reason: antiBotResult.reason,
    });
    return { ok: false };
  }

  const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);
  const authResult = await authenticateVirtualKey(resolvedAuthHeader);
  if ('error' in authResult) {
    await handlers.onAuthError({
      reply,
      requestIp,
      requestUserAgent,
      authError: authResult.error,
    });
    return { ok: false };
  }

  return {
    ok: true,
    context: {
      requestIp,
      requestUserAgent,
      resolvedAuthHeader,
      virtualKey: authResult.virtualKey,
      virtualKeyValue: authResult.virtualKeyValue,
    },
  };
}

export async function runProxyPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  handlers: ProxyPreflightHandlers
): Promise<ProxyPreflightResult> {
  const internal = getNodeRequestState(request);
  if (internal) return { ok: true, context: internal.preflight };
  const authResult = await runProxyAuthentication(request, reply, handlers);
  if (!authResult.ok) return authResult;
  const { virtualKey, requestIp, requestUserAgent } = authResult.context;

  // HTTP requests count here; WebSocket handshakes only authenticate and count each response.create.
  const rateLimit = virtualKeyRateLimiter.check(virtualKey.id, virtualKey.rate_limit);
  if (!rateLimit.allowed) {
    memoryLogger.warn(
      `虚拟密钥速率限制触发 | keyId: ${virtualKey.id} | limit: ${virtualKey.rate_limit} req/min | retryAfter: ${rateLimit.retryAfterSeconds}s | IP: ${requestIp}`,
      'RateLimit',
    );
    reply.header('Retry-After', String(rateLimit.retryAfterSeconds));
    await handlers.onRateLimited({
      reply,
      requestIp,
      requestUserAgent,
      limitPerMinute: Number(virtualKey.rate_limit),
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return { ok: false };
  }

  return authResult;
}

/**
 * Shared pre-check pipeline for all proxy protocols.
 *
 * Order:
 * 1) IP blocklist
 * 2) Anti-bot
 * 3) Auth (virtual key)
 * 4) Per-key rate limit (RPM)
 * 5) Protocol-specific hook (optional)
 * 6) Model/provider resolution
 * 7) Provider config build
 */
export async function runProxyPipeline(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProxyPipelineOptions
): Promise<ProxyPipelineResult> {
  const startedAt = Date.now();
  const internal = getNodeRequestState(request);
  const preflightResult = await runProxyPreflight(request, reply, options.handlers);
  if (!preflightResult.ok) {
    return { ok: false };
  }

  const {
    requestIp,
    requestUserAgent,
    resolvedAuthHeader,
    virtualKey,
    virtualKeyValue,
  } = preflightResult.context;

  const hookArgs: ProxyAfterAuthArgs = {
    request,
    reply,
    requestIp,
    requestUserAgent,
    virtualKey,
    virtualKeyValue,
  };
  if (options.afterAuth && !internal) {
    const hookResult = await options.afterAuth(hookArgs);
    if (hookResult === false) {
      return { ok: false };
    }
  }

  // Avoid colliding with Fastify's own `request.protocol` ('http'/'https').
  const modelResolverRequest: any = {
    body: request.body,
    headers: request.headers,
    protocol: options.protocol,
    url: request.url,
  };

  const logicalCacheKey = internal?.envelope.logicalCacheKey ?? hookArgs.logicalCacheKey ?? (options.protocol === 'openai'
    ? computeLogicalCacheKey(virtualKey, request.body, (request.body as any)?.stream === true, shouldBypassGatewayCache(request.url))
    : null);
  const modelResult = internal?.modelResult ?? await resolveModelAndProvider(
    virtualKey,
    modelResolverRequest as any,
    virtualKeyValue
  );
  if ('code' in modelResult) {
    await options.handlers.onModelError({
      reply,
      requestIp,
      requestUserAgent,
      virtualKey,
      virtualKeyValue,
      modelError: modelResult,
    });
    return { ok: false };
  }

  const { providerId, currentModel } = modelResult;
  if (appConfig.node.enabled && !internal) {
    const freshProvider = await providerDb.getById(providerId);
    if (!freshProvider || !freshProvider.enabled) {
      reply.code(503).send(nodeError('provider_unavailable', 'Provider is unavailable'));
      return { ok: false };
    }
    modelResult.provider = freshProvider;
  }
  const needsOwnerAdmission = appConfig.node.enabled && !isRemoteProvider(modelResult.provider) &&
    (internal ? !internal.ownerAdmitted : !modelResult.excludeTargetKeys);
  if (needsOwnerAdmission && !circuitBreaker.isAvailable(modelResult.circuitBreakerKey || providerId)) {
    if (internal && modelResult.canRetry && modelResult.modelId && modelResult.excludeTargetKeys &&
        Date.now() - internal.envelope.startedAt <= 10_000) {
      const next = await retrySmartRouting(virtualKey, modelResolverRequest, modelResult.modelId, modelResult.excludeTargetKeys);
      if (!('code' in next)) {
        const provider = await providerDb.getById(next.providerId);
        if (provider?.enabled) {
          internal.modelResult = { ...next, provider, forcedReasoningEffort: modelResult.forcedReasoningEffort, routeInfo: modelResult.routeInfo };
          // The owner router already acquired local half-open admission; never acquire it twice.
          internal.ownerAdmitted = !isRemoteProvider(provider);
          return runProxyPipeline(request, reply, options);
        }
      }
    }
    await options.handlers.onProviderConfigError({
      reply, requestIp, requestUserAgent, virtualKey, virtualKeyValue, providerId,
      providerConfigError: { code: 503, body: nodeError('owner_circuit_open', 'Provider circuit is open on its owner node') },
    });
    return { ok: false };
  }
  if (await forwardToOwner(request, reply, options.protocol, virtualKey, modelResult, {
    logicalCacheKey,
    startedAt: internal?.envelope.startedAt ?? startedAt,
    normalized: internal?.envelope.normalized ?? false,
  })) {
    return { ok: false };
  }
  const { provider } = modelResult;
  if (appConfig.node.enabled) {
    reply.header('x-gateway-execution-node', appConfig.node.id);
    reply.raw.setHeader('x-gateway-execution-node', appConfig.node.id);
  }

  const configResult = await buildProviderConfig(
    provider,
    virtualKey,
    virtualKeyValue,
    providerId,
    request,
    currentModel,
    options.protocol
  );
  if ('code' in configResult) {
    await options.handlers.onProviderConfigError({
      reply,
      requestIp,
      requestUserAgent,
      virtualKey,
      virtualKeyValue,
      providerId,
      providerConfigError: configResult,
    });
    return { ok: false };
  }

  return {
    ok: true,
    context: {
      requestIp,
      requestUserAgent,
      resolvedAuthHeader,
      virtualKey,
      virtualKeyValue,
      provider,
      providerId,
      currentModel,
      modelResult,
      configResult,
    },
  };
}
