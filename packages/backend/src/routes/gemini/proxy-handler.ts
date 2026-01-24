import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { extractIp } from '../../utils/ip.js';
import { manualIpBlocklist } from '../../services/manual-ip-blocklist.js';
import { getRequestUserAgent } from '../../utils/http.js';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader } from '../proxy/auth.js';
import { resolveModelAndProvider } from '../proxy/model-resolver.js';
import { buildProviderConfig } from '../proxy/provider-config-builder.js';
import { circuitBreaker } from '../../services/circuit-breaker.js';
import type { VirtualKey } from '../../types/index.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
import { calculateTokensIfNeeded } from '../proxy/token-calculator.js';
import { handleGeminiNativeNonStreamRequest, handleGeminiNativeStreamRequest } from './gemini-native.js';
import { shouldLogRequestBody } from '../proxy/handlers/shared.js';

export function createGeminiProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;
    let currentModel: any | undefined;
    let requestIp = 'unknown';
    let requestUserAgent = '';

    try {
      requestIp = extractIp(request);
      requestUserAgent = getRequestUserAgent(request);

      const manualBlock = await manualIpBlocklist.isBlocked(requestIp);
      if (manualBlock) {
        memoryLogger.warn(
          `拦截手动屏蔽 IP 请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${manualBlock.reason || '管理员拦截'}`,
          'ManualBlock'
        );
        return reply.code(403).send({ error: { message: 'Access denied: IP blocked', code: 403, status: 'PERMISSION_DENIED' } });
      }

      // Anti-bot
      const { antiBotService } = await import('../../services/anti-bot.js');
      const antiBotResult = antiBotService.detect(requestUserAgent, requestIp);
      antiBotService.logDetection(requestUserAgent, antiBotResult, requestIp, request.headers);

      if (antiBotResult.shouldBlock) {
        memoryLogger.warn(`拦截爬虫/威胁IP请求 | IP: ${requestIp} | UA: ${requestUserAgent} | 原因: ${antiBotResult.reason}`, 'AntiBot');
        return reply.code(403).send({ error: { message: 'Access denied: Bot detected', code: 403, status: 'PERMISSION_DENIED' } });
      }

      // Auth
      const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);
      const authResult = await authenticateVirtualKey(resolvedAuthHeader);
      
      if ('error' in authResult) {
        return reply.code(authResult.error.code).send(authResult.error.body);
      }

      const { virtualKey, virtualKeyValue: vkValue } = authResult;
      virtualKeyValue = vkValue;

      // Extract model from URL for Gemini Native (e.g. /v1beta/models/gemini-pro:generateContent)
      let modelFromUrl = '';
      const pathParts = request.url.split('/');
      const modelsIndex = pathParts.indexOf('models');
      if (modelsIndex !== -1 && pathParts[modelsIndex + 1]) {
        modelFromUrl = pathParts[modelsIndex + 1].split(':')[0];
      }

      const proxyRequest: any = {
        body: { ...request.body as any, model: modelFromUrl || (request.body as any)?.model },
        protocol: 'gemini' as const
      };

      const modelResult = await resolveModelAndProvider(virtualKey, proxyRequest, virtualKeyValue!);
      if ('code' in modelResult) {
        return reply.code(modelResult.code).send(modelResult.body);
      }

      const { provider, providerId: resolvedProviderId, currentModel: resolvedModel } = modelResult;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const configResult = await buildProviderConfig(
        provider,
        virtualKey,
        virtualKeyValue!,
        providerId,
        request,
        currentModel
      );
      
      if ('code' in configResult) {
        return reply.code(configResult.code).send(configResult.body);
      }

      const { protocolConfig, vkDisplay } = configResult;
      
      const isStream = request.url.includes('streamGenerateContent') || (request.query as any)?.alt === 'sse';

       memoryLogger.info(
        `Gemini 请求: ${currentModel?.model_identifier || modelFromUrl} | stream: ${isStream} | virtual key: ${vkDisplay}`,
        'Gemini'
      );

      if (isStream) {
        return await handleGeminiNativeStreamRequest(
          request,
          reply,
          protocolConfig,
          request.url,
          virtualKey,
          providerId,
          startTime,
          vkDisplay,
          currentModel
        );
      } else {
        return await handleGeminiNativeNonStreamRequest(
          request,
          reply,
          protocolConfig,
          request.url,
          virtualKey,
          providerId,
          startTime,
          vkDisplay,
          currentModel
        );
      }

    } catch (error: any) {
      const duration = Date.now() - startTime;
       memoryLogger.error(
        `Gemini proxy request failed: ${error.message}`,
        'Gemini',
        { error: error.stack }
      );

      if (virtualKeyValue && providerId) {
         const { virtualKeyDb } = await import('../../db/index.js');
         const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
         if (virtualKey) {
            const shouldLogBody = shouldLogRequestBody(virtualKey);
            await logApiRequestToDb({
              virtualKey,
              providerId: providerId!,
              model: currentModel?.name || 'unknown',
              tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              status: 'error',
              responseTime: duration,
              errorMessage: error.message,
              truncatedRequest: shouldLogBody ? JSON.stringify(request.body) : undefined,
              cacheHit: 0,
              ip: requestIp,
              userAgent: requestUserAgent,
            });
         }
      }

      if (!reply.sent) {
        return reply.code(500).send({ error: { message: error.message || 'Internal server error', code: 500, status: 'INTERNAL' } });
      }
    }
  };
}
