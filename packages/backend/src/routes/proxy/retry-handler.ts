import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { shouldRetrySmartRouting } from './routing.js';
import { retrySmartRouting, type ModelResolutionResult } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

export interface RetryContext {
  virtualKey: any;
  virtualKeyValue: string;
  vkDisplay: string;
  modelResult: ModelResolutionResult;
  currentModel?: any;
  compressionStats?: { originalTokens: number; savedTokens: number };
  startTime: number;
  isResponsesApi?: boolean;
  extractedSystemPrompt?: string;
}

const SMART_ROUTING_RETRY_WINDOW_MS = 10_000;

async function handleSmartRoutingRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext,
  isStream: boolean
): Promise<boolean> {
  if (!context.modelResult.canRetry) {
    if (!isStream) {
      memoryLogger.debug('不支持重试：不是智能路由模式', 'Proxy');
    }
    return false;
  }

  if (Date.now() - context.startTime > SMART_ROUTING_RETRY_WINDOW_MS) {
    memoryLogger.warn(
      isStream
        ? `智能路由重试(流式)终止：超过最大重试窗口 ${SMART_ROUTING_RETRY_WINDOW_MS}ms`
        : `智能路由重试终止：超过最大重试窗口 ${SMART_ROUTING_RETRY_WINDOW_MS}ms`,
      'Proxy'
    );
    return false;
  }

  if (!shouldRetrySmartRouting(statusCode)) {
    if (!isStream) {
      memoryLogger.debug(`状态码 ${statusCode} 不满足重试条件`, 'Proxy');
    }
    return false;
  }

  if (isStream && (reply.sent || reply.raw.headersSent)) {
    memoryLogger.debug('流式请求已发送响应，无法重试', 'Proxy');
    return false;
  }

  if (!context.modelResult.excludeProviders || !context.modelResult.modelId) {
    if (!isStream) {
      memoryLogger.warn('缺少重试所需信息', 'Proxy');
    }
    return false;
  }

  const logPrefix = isStream ? '智能路由重试(流式)' : '智能路由重试';
  memoryLogger.info(
    `${logPrefix}: 检测到失败 (${statusCode})，尝试下一个目标 | 已尝试: ${context.modelResult.excludeProviders.size}`,
    'Proxy'
  );

  const retryResult = await retrySmartRouting(
    context.virtualKey,
    request,
    context.modelResult.modelId,
    context.modelResult.excludeProviders
  );

  if ('code' in retryResult) {
    memoryLogger.warn(
      isStream
        ? `${logPrefix}失败: 没有更多可用目标`
        : `${logPrefix}失败: 没有更多可用目标 | 已尝试: ${context.modelResult.excludeProviders.size}`,
      'Proxy'
    );
    return false;
  }

  memoryLogger.info(
    `${logPrefix}: 切换到新目标 provider=${retryResult.provider.name}`,
    'Proxy'
  );

  if (retryResult.currentModel?.model_identifier) {
    (request.body as any).model = retryResult.currentModel.model_identifier;
  }

  const configResult = await buildProviderConfig(
    retryResult.provider,
    context.virtualKey,
    context.virtualKeyValue,
    retryResult.providerId,
    request,
    retryResult.currentModel
  );

  if ('code' in configResult) {
    memoryLogger.error(`${logPrefix}: 构建配置失败`, 'Proxy');
    return false;
  }

  if (isStream) {
    const { handleStreamRequest } = await import('../openai/proxy-handler.js');
    await handleStreamRequest(
      request,
      reply,
      configResult.protocolConfig,
      configResult.path,
      context.vkDisplay,
      context.virtualKey,
      retryResult.providerId,
      context.startTime,
      context.compressionStats,
      retryResult.currentModel,
      !!context.isResponsesApi,
      retryResult,
      context.virtualKeyValue,
      context.extractedSystemPrompt
    );
    return true;
  }

  const { handleNonStreamRequest } = await import('../openai/proxy-handler.js');
  await handleNonStreamRequest(
    request,
    reply,
    configResult.protocolConfig,
    context.virtualKey,
    retryResult.providerId,
    configResult.isStreamRequest,
    configResult.path,
    context.startTime,
    context.compressionStats,
    retryResult.currentModel,
    retryResult,
    context.virtualKeyValue
  );
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
