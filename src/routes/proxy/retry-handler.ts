import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { shouldRetrySmartRouting } from './routing.js';
import { retrySmartRouting, type ModelResolutionResult } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

export interface RetryContext {
  virtualKey: any;
  virtualKeyValue: string;
  modelResult: ModelResolutionResult;
  currentModel?: any;
  compressionStats?: { originalTokens: number; savedTokens: number };
  startTime: number;
}

/**
 * 处理智能路由的非流式请求重试
 */
export async function handleNonStreamRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext
): Promise<boolean> {
  // 检查是否满足重试条件
  if (!context.modelResult.canRetry) {
    memoryLogger.debug('不支持重试：不是智能路由模式', 'Proxy');
    return false;
  }

  if (!shouldRetrySmartRouting(statusCode)) {
    memoryLogger.debug(`状态码 ${statusCode} 不满足重试条件`, 'Proxy');
    return false;
  }

  if (!context.modelResult.excludeProviders || !context.modelResult.modelId) {
    memoryLogger.warn('缺少重试所需信息', 'Proxy');
    return false;
  }

  memoryLogger.info(
    `智能路由重试: 检测到失败 (${statusCode})，尝试下一个目标 | 已尝试: ${context.modelResult.excludeProviders.size}`,
    'Proxy'
  );

  // 重新解析 provider（排除已失败的）
  const retryResult = await retrySmartRouting(
    context.virtualKey,
    request,
    context.modelResult.modelId,
    context.modelResult.excludeProviders
  );

  if ('code' in retryResult) {
    memoryLogger.warn(
      `智能路由重试失败: 没有更多可用目标 | 已尝试: ${context.modelResult.excludeProviders.size}`,
      'Proxy'
    );
    return false;
  }

  memoryLogger.info(
    `智能路由重试: 切换到新目标 provider=${retryResult.provider.name}`,
    'Proxy'
  );

  // 更新 request.body.model 如果有 override
  if (retryResult.currentModel?.model_identifier) {
    (request.body as any).model = retryResult.currentModel.model_identifier;
  }

  // 重新构建 provider config
  const configResult = await buildProviderConfig(
    retryResult.provider,
    context.virtualKey,
    context.virtualKeyValue,
    retryResult.providerId,
    request,
    retryResult.currentModel
  );

  if ('code' in configResult) {
    memoryLogger.error('智能路由重试: 构建配置失败', 'Proxy');
    return false;
  }

  // 重新发起非流式请求
  const { handleNonStreamRequest } = await import('./proxy-handler.js');
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
    retryResult.currentModel
  );

  return true;
}

/**
 * 处理智能路由的流式请求重试
 */
export async function handleStreamRetry(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  context: RetryContext
): Promise<boolean> {
  // 检查是否满足重试条件
  if (!context.modelResult.canRetry) {
    return false;
  }

  if (!shouldRetrySmartRouting(statusCode)) {
    return false;
  }

  // 流式请求如果已经开始发送，则不能重试
  if (reply.sent) {
    memoryLogger.debug('流式请求已发送响应，无法重试', 'Proxy');
    return false;
  }

  if (!context.modelResult.excludeProviders || !context.modelResult.modelId) {
    return false;
  }

  memoryLogger.info(
    `智能路由重试(流式): 检测到失败 (${statusCode})，尝试下一个目标 | 已尝试: ${context.modelResult.excludeProviders.size}`,
    'Proxy'
  );

  // 重新解析 provider
  const retryResult = await retrySmartRouting(
    context.virtualKey,
    request,
    context.modelResult.modelId,
    context.modelResult.excludeProviders
  );

  if ('code' in retryResult) {
    memoryLogger.warn(
      `智能路由重试(流式)失败: 没有更多可用目标`,
      'Proxy'
    );
    return false;
  }

  memoryLogger.info(
    `智能路由重试(流式): 切换到新目标 provider=${retryResult.provider.name}`,
    'Proxy'
  );

  // 更新 request.body.model
  if (retryResult.currentModel?.model_identifier) {
    (request.body as any).model = retryResult.currentModel.model_identifier;
  }

  // 重新构建 provider config
  const configResult = await buildProviderConfig(
    retryResult.provider,
    context.virtualKey,
    context.virtualKeyValue,
    retryResult.providerId,
    request,
    retryResult.currentModel
  );

  if ('code' in configResult) {
    memoryLogger.error('智能路由重试(流式): 构建配置失败', 'Proxy');
    return false;
  }

  // 重新发起流式请求
  const { handleStreamRequest } = await import('./proxy-handler.js');
  await handleStreamRequest(
    request,
    reply,
    configResult.protocolConfig,
    configResult.path,
    context.virtualKeyValue,
    context.virtualKey,
    retryResult.providerId,
    context.startTime,
    context.compressionStats,
    retryResult.currentModel
  );

  return true;
}
