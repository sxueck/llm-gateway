import type { FastifyReply, FastifyRequest } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { extractVirtualKeyAuthHeader, authenticateVirtualKey } from './auth.js';
import { virtualKeyRateLimiter } from '../../services/virtual-key-rate-limiter.js';
import { resolveModelAndProvider } from './model-resolver.js';
import {
  currentQuotaModel,
  modelDailyQuota,
  stampQuotaModel,
} from '../../services/model-daily-quota.js';
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
  /** Model daily token budget exhausted (system_config model_daily_token_limits). */
  onQuotaExceeded: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    modelName: string;
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

  // Charge gateway-cache hits too: they return from `afterAuth` before model
  // resolution, so the addressed name is only readable from the client body.
  // runProxyPipeline re-stamps with the post-resolution (suffix-stripped) name.
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
 * 6) Model/provider resolution + model daily token budget
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
    const quota = await modelDailyQuota.check(quotaModel);
    if (quota.allowed) return true;

    memoryLogger.warn(
      `模型每日 token 额度耗尽 | model: ${quota.model} | used: ${quota.usedTokens}/${quota.limitTokens} | retryAfter: ${quota.retryAfterSeconds}s | keyId: ${virtualKey.id} | IP: ${requestIp}`,
      'Quota',
    );
    reply.header('Retry-After', String(quota.retryAfterSeconds));
    await options.handlers.onQuotaExceeded({
      reply,
      requestIp,
      requestUserAgent,
      modelName: quota.model,
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

  // Daily token budget of the addressed model: the name the client sent (after
  // suffix / tier resolution that is the base model name), so a virtual model
  // keeps its own budget and every virtual key draws from the same pool.
  const requestedModel =
    typeof (request.body as any)?.model === 'string'
      ? (request.body as any).model
      : undefined;
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
