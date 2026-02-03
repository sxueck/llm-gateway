import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { logApiRequestToDb } from '../../services/api-request-logger.js';
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
    let modelFromUrl = '';

    try {
      const pipelineResult = await runProxyPipeline(request, reply, {
        protocol: 'gemini',
        handlers: {
          onManualBlock: ({ reply }) => {
            reply.code(403).send({ error: { message: 'Access denied: IP blocked', code: 403, status: 'PERMISSION_DENIED' } });
          },
          onAntiBotBlock: ({ reply }) => {
            reply.code(403).send({ error: { message: 'Access denied: Bot detected', code: 403, status: 'PERMISSION_DENIED' } });
          },
          onAuthError: ({ reply, authError }) => {
            reply.code(authError.code).send(authError.body);
          },
          onModelError: ({ reply, modelError }) => {
            reply.code(modelError.code).send(modelError.body);
          },
          onProviderConfigError: ({ reply, providerConfigError }) => {
            reply.code(providerConfigError.code).send(providerConfigError.body);
          },
        },
        afterAuth: ({ virtualKeyValue: vkValue }) => {
          virtualKeyValue = vkValue;

          // Extract model from URL for Gemini Native (e.g. /v1beta/models/gemini-pro:generateContent)
          const pathParts = request.url.split('/');
          const modelsIndex = pathParts.indexOf('models');
          if (modelsIndex !== -1 && pathParts[modelsIndex + 1]) {
            modelFromUrl = pathParts[modelsIndex + 1].split(':')[0];
          }

          // Ensure model is available for model resolver.
          if (!request.body || typeof request.body !== 'object') {
            request.body = {} as any;
          }
          if (modelFromUrl && !(request.body as any).model) {
            (request.body as any).model = modelFromUrl;
          }

          return true;
        },
      });

      if (!pipelineResult.ok) {
        return;
      }

      const {
        requestIp: pipelineIp,
        requestUserAgent: pipelineUa,
        virtualKey,
        virtualKeyValue: vkValue,
        providerId: resolvedProviderId,
        currentModel: resolvedModel,
        configResult,
      } = pipelineResult.context;

      requestIp = pipelineIp;
      requestUserAgent = pipelineUa;
      virtualKeyValue = vkValue;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const { protocolConfig, vkDisplay, isStreamRequest } = configResult;

       memoryLogger.info(
        `Gemini 请求: ${currentModel?.model_identifier || modelFromUrl} | stream: ${isStreamRequest} | virtual key: ${vkDisplay}`,
        'Gemini'
      );

      if (isStreamRequest) {
        return await handleGeminiNativeStreamRequest(
          request,
          reply,
          protocolConfig,
          request.url,
          virtualKey,
          resolvedProviderId,
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
          resolvedProviderId,
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
              providerId,
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
