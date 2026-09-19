import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { shouldRetrySmartRouting } from './routing.js';
import { retrySmartRouting, type ModelResolutionResult } from './model-resolver.js';
import { buildProviderConfig, type ProviderConfigResult } from './provider-config-builder.js';

export interface RetryContext {
  virtualKey: any;
  virtualKeyValue: string;
  vkDisplay: string;
  modelResult: ModelResolutionResult;
  currentModel?: any;
  compressionStats?: { originalTokens: number; savedTokens: number };
  startTime: number;
  isResponsesApi?: boolean;
  entrypointProtocol?: 'openai' | 'anthropic' | 'gemini';
  /** Cache coalescing: lock identity of the request that dispatched this retry. */
  cacheLockKey?: string;
  cacheLockOwner?: string;
  /**
   * Logical response-cache key (see ProxyRequestContext.logicalCacheKey).
   * Forwarded to the OpenAI non-stream re-entry so retries keep filling and
   * polling the same cache entry as the original attempt.
   */
  logicalCacheKey?: string | null;
  /**
   * Pristine, globally-normalized request body captured by the entrypoint route before
   * any target-specific mutation (serving-cap clamp, model attributes, PII masking).
   * Replayed before the retry target so it never receives the failed target's
   * residue (e.g., the first target's PII surrogates or extra_body attributes).
   */
  retryBodySnapshot?: any;
}

const SMART_ROUTING_RETRY_WINDOW_MS = 10_000;

/** Deep-clone a request body for retry snapshot use; undefined when uncloneable. */
export function cloneSmartRoutingRetryBody(body: any): any {
  if (body === undefined || body === null) return body;
  try {
    return structuredClone(body);
  } catch (_e) {
    try {
      return JSON.parse(JSON.stringify(body));
    } catch (_e2) {
      return undefined;
    }
  }
}

export interface SmartRoutingRetrySelection {
  /** Model-resolution result for the retry target (updated excludeTargetKeys). */
  modelResult: ModelResolutionResult;
  /** Provider config for the retry target, built with the entrypoint protocol. */
  configResult: ProviderConfigResult;
  providerId: string;
}

/**
 * Protocol-agnostic smart-routing retry target selection.
 *
 * Performs every cross-protocol-safe decision — retry eligibility (canRetry,
 * retry window, retryable status), stream response-state guard, target
 * re-selection with exclusions, and provider config rebuild for the entrypoint
 * protocol — and returns the selected target. Protocol-specific re-entry
 * (request-body representation per protocol) stays with the callers, so a
 * retry never crosses protocol handlers.
 */
export async function selectSmartRoutingRetryTarget(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext,
  isStream: boolean
): Promise<SmartRoutingRetrySelection | null> {
  if (!context.modelResult.canRetry) {
    if (!isStream) {
      memoryLogger.debug('不支持重试：不是智能路由模式', 'Proxy');
    }
    return null;
  }

  if (Date.now() - context.startTime > SMART_ROUTING_RETRY_WINDOW_MS) {
    memoryLogger.warn(
      isStream
        ? `智能路由重试(流式)终止：超过最大重试窗口 ${SMART_ROUTING_RETRY_WINDOW_MS}ms`
        : `智能路由重试终止：超过最大重试窗口 ${SMART_ROUTING_RETRY_WINDOW_MS}ms`,
      'Proxy'
    );
    return null;
  }

  if (!shouldRetrySmartRouting(statusCode)) {
    if (!isStream) {
      memoryLogger.debug(`状态码 ${statusCode} 不满足重试条件`, 'Proxy');
    }
    return null;
  }

  if (isStream && (reply.sent || reply.raw.headersSent)) {
    memoryLogger.debug('流式请求已发送响应，无法重试', 'Proxy');
    return null;
  }

  if (!context.modelResult.excludeTargetKeys || !context.modelResult.modelId) {
    if (!isStream) {
      memoryLogger.warn('缺少重试所需信息', 'Proxy');
    }
    return null;
  }

  const logPrefix = isStream ? '智能路由重试(流式)' : '智能路由重试';
  memoryLogger.info(
    `${logPrefix}: 检测到失败 (${statusCode})，尝试下一个目标 | 已尝试: ${context.modelResult.excludeTargetKeys.size}`,
    'Proxy'
  );

  const retryResult = await retrySmartRouting(
    context.virtualKey,
    request,
    context.modelResult.modelId,
    context.modelResult.excludeTargetKeys
  );

  if ('code' in retryResult) {
    memoryLogger.warn(
      isStream
        ? `${logPrefix}失败: 没有更多可用目标`
        : `${logPrefix}失败: 没有更多可用目标 | 已尝试: ${context.modelResult.excludeTargetKeys.size}`,
      'Proxy'
    );
    return null;
  }

  const retriedModelResult = {
    ...retryResult,
    forcedReasoningEffort: context.modelResult.forcedReasoningEffort,
  };

  memoryLogger.info(
    `${logPrefix}: 切换到新目标 provider=${retryResult.provider.name}`,
    'Proxy'
  );

  const configResult = await buildProviderConfig(
    retryResult.provider,
    context.virtualKey,
    context.virtualKeyValue,
    retryResult.providerId,
    request,
    retryResult.currentModel,
    context.entrypointProtocol
  );

  if ('code' in configResult) {
    memoryLogger.error(`${logPrefix}: 构建配置失败`, 'Proxy');
    return null;
  }

  return {
    modelResult: retriedModelResult,
    configResult,
    providerId: retryResult.providerId,
  };
}

/**
 * Replay the pristine body snapshot captured before the failed target's
 * mutations so the retry target gets a clean, globally-normalized body — this
 * also prevents re-masking the first target's PII surrogates (the original
 * text is masked fresh for this target, producing this target's own
 * surrogates).
 */
function replayRetryBodySnapshot(
  request: FastifyRequest,
  snapshot: any | undefined,
  logPrefix: string
): void {
  if (snapshot === undefined) {
    return;
  }
  const pristineBody = cloneSmartRoutingRetryBody(snapshot);
  if (pristineBody !== undefined) {
    request.body = pristineBody;
    memoryLogger.debug(`${logPrefix}: 已恢复重试前请求体快照`, 'Proxy');
  }
}

async function handleSmartRoutingRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext,
  isStream: boolean
): Promise<boolean> {
  const selection = await selectSmartRoutingRetryTarget(request, reply, statusCode, context, isStream);
  if (!selection) {
    return false;
  }

  const { modelResult: retriedModelResult, configResult, providerId } = selection;
  const logPrefix = isStream ? '智能路由重试(流式)' : '智能路由重试';
  const entrypointProtocol = context.entrypointProtocol || 'openai';

  replayRetryBodySnapshot(request, context.retryBodySnapshot, logPrefix);

  if (entrypointProtocol === 'anthropic') {
    // Protocol-correct re-entry: rebuild the Anthropic request against the new
    // target (model rewrite, serving-cap clamp, disable_thinking) and dispatch
    // through the Anthropic /v1/messages handlers. Never routed through the
    // OpenAI handlers, so the wire representation stays Anthropic.
    const anthropicProxyModule = await import('../anthropic/proxy-handler.js');
    if (retriedModelResult.currentModel?.model_identifier) {
      (request.body as any).model = retriedModelResult.currentModel.model_identifier;
    }
    await anthropicProxyModule.dispatchAnthropicRequest({
      request,
      reply,
      virtualKey: context.virtualKey,
      virtualKeyValue: context.virtualKeyValue,
      providerId,
      currentModel: retriedModelResult.currentModel,
      modelResult: retriedModelResult,
      startTime: context.startTime,
      protocolConfig: configResult.protocolConfig,
      vkDisplay: configResult.vkDisplay,
      retryBodySnapshot: context.retryBodySnapshot,
    });
    return true;
  }

  if (entrypointProtocol === 'gemini') {
    // Protocol-correct re-entry: rebuild the Gemini-native request against the
    // new target (native URL model rewrite, disable_thinking) and dispatch
    // through the Gemini native passthrough handlers.
    const geminiProxyModule = await import('../gemini/proxy-handler.js');
    if (retriedModelResult.currentModel?.model_identifier) {
      (request.body as any).model = retriedModelResult.currentModel.model_identifier;
    }
    await geminiProxyModule.dispatchGeminiRequest({
      request,
      reply,
      virtualKey: context.virtualKey,
      virtualKeyValue: context.virtualKeyValue,
      providerId,
      currentModel: retriedModelResult.currentModel,
      modelResult: retriedModelResult,
      startTime: context.startTime,
      protocolConfig: configResult.protocolConfig,
      vkDisplay: configResult.vkDisplay,
      isStreamRequest: configResult.isStreamRequest,
      retryBodySnapshot: context.retryBodySnapshot,
    });
    return true;
  }

  const openaiProxyModule = await import('../openai/proxy-handler.js');

  if (retriedModelResult.currentModel?.model_identifier) {
    (request.body as any).model = retriedModelResult.currentModel.model_identifier;
  }

  // Re-run the retry target's own configuration/attributes through the normal
  // OpenAI mutation path (serving-cap clamp, extra_body, disable_thinking) so
  // target B receives the same treatment as a first attempt.
  const targetMutations = openaiProxyModule.applyOpenAITargetModelMutations(request, retriedModelResult.currentModel);

  if (isStream) {
    await openaiProxyModule.handleStreamRequest({
      request,
      reply,
      protocolConfig: configResult.protocolConfig,
      path: configResult.path,
      virtualKey: context.virtualKey,
      providerId,
      startTime: context.startTime,
      compressionStats: context.compressionStats,
      currentModel: retriedModelResult.currentModel,
      modelResult: retriedModelResult,
      virtualKeyValue: context.virtualKeyValue,
      modelAttributes: targetMutations.modelAttributes,
      effectiveMaxCompletionTokens: targetMutations.effectiveMaxCompletionTokens,
      retryBodySnapshot: context.retryBodySnapshot,
    });
    return true;
  }

  await openaiProxyModule.handleNonStreamRequest({
    request,
    reply,
    protocolConfig: configResult.protocolConfig,
    path: configResult.path,
    virtualKey: context.virtualKey,
    providerId,
    startTime: context.startTime,
    compressionStats: context.compressionStats,
    currentModel: retriedModelResult.currentModel,
    modelResult: retriedModelResult,
    virtualKeyValue: context.virtualKeyValue,
    modelAttributes: targetMutations.modelAttributes,
    effectiveMaxCompletionTokens: targetMutations.effectiveMaxCompletionTokens,
    retryBodySnapshot: context.retryBodySnapshot,
    logicalCacheKey: context.logicalCacheKey,
    cacheLockKey: context.cacheLockKey,
    cacheLockOwner: context.cacheLockOwner,
  });
  return true;
}

export async function handleNonStreamRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext
): Promise<boolean> {
  return handleSmartRoutingRetry(request, reply, statusCode, context, false);
}

export async function handleStreamRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext
): Promise<boolean> {
  return handleSmartRoutingRetry(request, reply, statusCode, context, true);
}
