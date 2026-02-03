import type { FastifyReply, FastifyRequest } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { manualIpBlocklist } from '../../services/manual-ip-blocklist.js';
import { extractVirtualKeyAuthHeader, authenticateVirtualKey } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

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

export interface ProxyPipelineHandlers {
  onManualBlock: (args: {
    reply: FastifyReply;
    requestIp: string;
    requestUserAgent: string;
    reason?: string;
  }) => Promise<void> | void;
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
  }) => Promise<boolean | void> | boolean | void;
}

export type ProxyPipelineResult =
  | { ok: true; context: ProxyPipelineContext }
  | { ok: false };

/**
 * Shared pre-check pipeline for all proxy protocols.
 *
 * Order:
 * 1) IP blocklist
 * 2) Anti-bot
 * 3) Auth (virtual key)
 * 4) Protocol-specific hook (optional)
 * 5) Model/provider resolution
 * 6) Provider config build
 */
export async function runProxyPipeline(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProxyPipelineOptions
): Promise<ProxyPipelineResult> {
  const requestIp = extractIp(request);
  const requestUserAgent = getRequestUserAgent(request);

  const manualBlock = await manualIpBlocklist.isBlocked(requestIp);
  if (manualBlock) {
    memoryLogger.warn(
      `拦截手动屏蔽 IP 请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${manualBlock.reason || '管理员拦截'}`,
      'ManualBlock'
    );
    await options.handlers.onManualBlock({
      reply,
      requestIp,
      requestUserAgent,
      reason: manualBlock.reason || undefined,
    });
    return { ok: false };
  }

  const { antiBotService } = await import('../../services/anti-bot.js');
  const antiBotResult = antiBotService.detect(requestUserAgent, requestIp);
  antiBotService.logDetection(requestUserAgent, antiBotResult, requestIp, request.headers);
  if (antiBotResult.shouldBlock) {
    memoryLogger.warn(
      `拦截爬虫/威胁IP请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${antiBotResult.reason}`,
      'AntiBot'
    );
    await options.handlers.onAntiBotBlock({
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
    await options.handlers.onAuthError({
      reply,
      requestIp,
      requestUserAgent,
      authError: authResult.error,
    });
    return { ok: false };
  }

  const { virtualKey, virtualKeyValue } = authResult;

  if (options.afterAuth) {
    const hookResult = await options.afterAuth({
      request,
      reply,
      requestIp,
      requestUserAgent,
      virtualKey,
      virtualKeyValue,
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

  const configResult = await buildProviderConfig(
    provider,
    virtualKey,
    virtualKeyValue,
    providerId,
    request,
    currentModel
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
