import type { FastifyReply, FastifyRequest } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { extractVirtualKeyAuthHeader, authenticateVirtualKey } from './auth.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import { resolveModelAndProvider } from './model-resolver.js';
import {
  currentQuotaModel,
  stampQuotaModel,
  virtualKeyQuota,
} from '../../services/virtual-key-quota.js';
import { buildProviderConfig } from './provider-config-builder.js';

export type ProxyProtocol = 'openai' | 'anthropic' | 'gemini';

/**
 * Human-readable retry duration for client-facing quota errors: hours when
 * possible, falling back to minutes/seconds so values just past midnight
 * don't render as "0.0h".
 */
export function formatRetryDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  if (seconds >= 60) {
    return `${Math.ceil(seconds / 60)}m`;
  }
  return `${Math.max(1, Math.ceil(seconds))}s`;
}

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
  /** Per-key token budget exhausted (virtual_key_model_quotas). */
  onQuotaExceeded: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    virtualKeyId: string;
    modelName: string;
    /** Which ceiling tripped; a missing value keeps the historical daily wording/code. */
    period?: 'daily' | 'weekly';
    limitTokens: number;
    usedTokens: number;
    retryAfterSeconds: number;
  }) => Promise<void> | void;
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

export interface ProxyPipelineOptions {
  protocol: ProxyProtocol;
  handlers: ProxyPipelineHandlers;
  // Runs after auth succeeds and before model/provider resolution.
  // Return false if the hook already sent a response and the pipeline should stop.
  afterAuth?: (args: {
    request: FastifyRequest;
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    virtualKey: any;
    virtualKeyValue: string;
    /** Check before an early success response (for example, a gateway-cache hit). */
    checkQuota: (modelName?: string) => Promise<boolean>;
  }) => Promise<boolean | void> | boolean | void;
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

  // Cache hits return from `afterAuth` before model resolution, so the client
  // body is all there is here; runProxyPipeline re-stamps the canonical name.
  const clientModel =
    typeof (request.body as any)?.model === 'string'
      ? (request.body as any).model
      : undefined;
  if (clientModel) stampQuotaModel(clientModel);

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
 * 6) Model/provider resolution + per-key model daily/weekly token budget
 * 7) Provider config build
 */
export async function runProxyPipeline(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProxyPipelineOptions
): Promise<ProxyPipelineResult> {
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

  const checkQuota = async (modelName?: string): Promise<boolean> => {
    const quotaModel = modelName ?? currentQuotaModel();
    stampQuotaModel(quotaModel);
    const quota = await virtualKeyQuota.check(virtualKey.id, quotaModel);
    if (quota.allowed) return true;

    memoryLogger.warn(
      `虚拟密钥模型${quota.period === 'weekly' ? '每周' : '每日'} token 额度耗尽 | keyId: ${virtualKey.id} | model: ${quota.model} | used: ${quota.usedTokens}/${quota.limitTokens} | retryAfter: ${quota.retryAfterSeconds}s | IP: ${requestIp}`,
      'Quota',
    );
    reply.header('Retry-After', String(quota.retryAfterSeconds));
    await options.handlers.onQuotaExceeded({
      reply,
      requestIp,
      requestUserAgent,
      virtualKeyId: virtualKey.id,
      modelName: quota.model,
      period: quota.period,
      limitTokens: quota.limitTokens,
      usedTokens: quota.usedTokens,
      retryAfterSeconds: quota.retryAfterSeconds,
    });
    return false;
  };

  if (options.afterAuth) {
    const hookResult = await options.afterAuth({
      request,
      reply,
      requestIp,
      requestUserAgent,
      virtualKey,
      virtualKeyValue,
      checkQuota,
    });
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

  const modelResult = await resolveModelAndProvider(
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

  const { provider, providerId, currentModel } = modelResult;

  // Provider-scoped keys resolve no model entity, so the client string is the
  // fallback there — and such keys can have no name-based ceiling either.
  const requestedModel =
    modelResult.addressedModelName ??
    (typeof (request.body as any)?.model === 'string'
      ? (request.body as any).model
      : undefined);
  if (!(await checkQuota(requestedModel))) {
    return { ok: false };
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
