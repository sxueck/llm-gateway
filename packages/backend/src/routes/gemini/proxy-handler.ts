import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { runProxyPipeline } from '../proxy/pipeline.js';
import { logApiRequestAsync } from '../../services/api-request-logger.js';
import { handleGeminiNativeNonStreamRequest, handleGeminiNativeStreamRequest } from './gemini-native.js';
import { shouldLogRequestBody } from '../proxy/handlers/shared.js';
import { parseModelAttributes } from '../proxy/model-handlers.js';
import { cloneSmartRoutingRetryBody } from '../proxy/retry-handler.js';
import { applyDisableThinking } from '../../utils/thinking-control.js';
import { capturePromptSampleAsync } from '../../services/prompt-capture-service.js';
import { applyContextNormalization } from '../../services/context-normalization/index.js';

/** Extract the model name from a Gemini-native URL (e.g. /v1beta/models/gemini-pro:generateContent). */
export function extractGeminiModelFromUrl(url: string): string {
  const pathParts = url.split('/');
  const modelsIndex = pathParts.indexOf('models');
  if (modelsIndex !== -1 && pathParts[modelsIndex + 1]) {
    return pathParts[modelsIndex + 1].split(':')[0];
  }
  return '';
}

export interface GeminiDispatchArgs {
  request: FastifyRequest;
  reply: FastifyReply;
  protocolConfig: any;
  virtualKey: any;
  providerId: string;
  currentModel?: any;
  modelResult?: any;
  startTime: number;
  vkDisplay: string;
  isStreamRequest: boolean;
  virtualKeyValue?: string;
  retryBodySnapshot?: any;
}

/**
 * Gemini-protocol dispatch: applies this target's model mutations
 * (disable_thinking) and the native URL model rewrite, then routes to the
 * Gemini-native stream/non-stream handlers with the pipeline circuit key.
 * Used by the initial request AND by protocol-correct smart-routing retries —
 * retries re-enter here with the retry target's config, never through another
 * protocol's handlers.
 */
export async function dispatchGeminiRequest(args: GeminiDispatchArgs): Promise<void> {
  const {
    request,
    reply,
    protocolConfig,
    virtualKey,
    providerId,
    currentModel,
    modelResult,
    startTime,
    vkDisplay,
    isStreamRequest,
    virtualKeyValue,
    retryBodySnapshot,
  } = args;

  const modelAttributes = parseModelAttributes(currentModel?.model_attributes);
  if (modelAttributes?.disable_thinking && applyDisableThinking(request.body, 'gemini')) {
    memoryLogger.info(`已禁用思考 (disable_thinking) | 模型: ${currentModel?.name}`, 'Gemini');
  }

  const modelFromUrl = extractGeminiModelFromUrl(request.url);
  const resolvedModelIdentifier = currentModel?.model_identifier;
  let upstreamUrl = request.url;

  if (resolvedModelIdentifier && modelFromUrl && modelFromUrl !== resolvedModelIdentifier) {
    upstreamUrl = request.url.replace(
      new RegExp(`/models/${modelFromUrl}([:/?]|$)`),
      `/models/${resolvedModelIdentifier}$1`
    );
    memoryLogger.info(
      `Gemini 模型标识转换: URL模型名="${modelFromUrl}" -> model_identifier="${resolvedModelIdentifier}"`,
      'Gemini'
    );
  }

  memoryLogger.info(
    `Gemini 请求: 解析模型="${currentModel?.name || 'unknown'}" | model_identifier="${resolvedModelIdentifier || modelFromUrl}" | stream: ${isStreamRequest} | virtual key: ${vkDisplay}`,
    'Gemini'
  );

  // Thread the pipeline circuit key so every terminal upstream outcome inside
  // the native handlers is recorded against modelResult.circuitBreakerKey.
  const nativeOptions = {
    circuitBreakerKey: modelResult?.circuitBreakerKey || providerId,
    modelResult,
    virtualKeyValue,
    retryBodySnapshot,
  };

  if (isStreamRequest) {
    return await handleGeminiNativeStreamRequest(
      request,
      reply,
      protocolConfig,
      upstreamUrl,
      virtualKey,
      providerId,
      startTime,
      vkDisplay,
      currentModel,
      nativeOptions
    );
  }

  return await handleGeminiNativeNonStreamRequest(
    request,
    reply,
    protocolConfig,
    upstreamUrl,
    virtualKey,
    providerId,
    startTime,
    vkDisplay,
    currentModel,
    nativeOptions
  );
}

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
        afterAuth: ({ virtualKey, virtualKeyValue: vkValue }) => {
          virtualKeyValue = vkValue;

          // Extract model from URL for Gemini Native (e.g. /v1beta/models/gemini-pro:generateContent)
          modelFromUrl = extractGeminiModelFromUrl(request.url);

          // Ensure model is available for model resolver.
          if (!request.body || typeof request.body !== 'object') {
            request.body = {} as any;
          }
          if (modelFromUrl && !(request.body as any).model) {
            (request.body as any).model = modelFromUrl;
          }

          capturePromptSampleAsync(virtualKey, request, 'gemini');

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
        modelResult,
        configResult,
      } = pipelineResult.context;

      requestIp = pipelineIp;
      requestUserAgent = pipelineUa;
      virtualKeyValue = vkValue;
      providerId = resolvedProviderId;
      currentModel = resolvedModel;

      const normalization = await applyContextNormalization({
        protocol: 'gemini',
        request,
        body: request.body,
        providerId: resolvedProviderId,
        model: (request.body as any)?.model || modelFromUrl,
        virtualKey,
      });
      if (normalization.blocked) {
        return reply.code(normalization.status).send(normalization.body);
      }

      // Smart-routing retry safety: snapshot the globally-normalized body (context
      // normalization, URL model injection) BEFORE any target-specific mutation
      // (disable_thinking) so a retry to the next target replays a pristine body.
      const retryBodySnapshot = cloneSmartRoutingRetryBody(request.body);

      const { protocolConfig, vkDisplay, isStreamRequest } = configResult;

      return await dispatchGeminiRequest({
        request,
        reply,
        protocolConfig,
        virtualKey,
        providerId: resolvedProviderId,
        currentModel,
        modelResult,
        startTime,
        vkDisplay,
        isStreamRequest,
        virtualKeyValue: vkValue,
        retryBodySnapshot,
      });
    } catch (error: any) {
      const duration = Date.now() - startTime;
       memoryLogger.error(
        `Gemini proxy request failed: ${error.message}`,
        'Gemini',
        { error: error.stack }
      );

      // Best-effort audit of the failed request. Fire-and-forget and fully guarded:
      // an audit/logging outage must never change the response delivered to the client.
      try {
        if (virtualKeyValue && providerId) {
          const { virtualKeyDb } = await import('../../db/index.js');
          const virtualKey = await virtualKeyDb.getByKeyValue(virtualKeyValue);
          if (virtualKey) {
            const shouldLogBody = shouldLogRequestBody(virtualKey);
            logApiRequestAsync({
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
      } catch (auditError: any) {
        memoryLogger.warn(`失败请求审计记录异常(已忽略): ${auditError?.message || auditError}`, 'Gemini');
      }

      if (!reply.sent) {
        return reply.code(500).send({ error: { message: error.message || 'Internal server error', code: 500, status: 'INTERNAL' } });
      }
    }
  };
}
