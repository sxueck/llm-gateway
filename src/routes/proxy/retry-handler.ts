import { memoryLogger } from '../../services/logger.js';
import type { LoadBalanceRetryContext } from './routing.js';
import type { VirtualKey } from '../../types/index.js';

export interface RetryContext {
  request: any;
  reply: any;
  virtualKey: VirtualKey;
  vkDisplay: string;
  currentModel?: any;
  compressionStats?: { originalTokens: number; savedTokens: number };
  startTime: number;
  path: string;
  isStreamRequest: boolean;
}

export async function handleLoadBalanceRetry(
  retryContext: LoadBalanceRetryContext,
  context: RetryContext,
  errorStatus?: number,
  isStreamError: boolean = false
): Promise<boolean> {
  const statusCode = errorStatus || 500;
  
  // 检查是否应该重试
  if (!retryContext) return false;
  
  // 对于流式请求，需要检查响应是否已发送
  if (isStreamError && context.reply.sent) return false;
  
  // 检查错误状态码是否可重试
  if (!shouldRetryLoadBalance(statusCode)) return false;

  const logPrefix = isStreamError ? '负载均衡重试(流式)' : '负载均衡重试';
  
  memoryLogger.info(
    `${logPrefix}: 检测到失败 (${statusCode})，尝试下一个目标`,
    'Proxy'
  );
  
  const { retryNextLoadBalanceTarget } = await import('./routing.js');
  const nextTarget = await retryNextLoadBalanceTarget(retryContext);
  
  if (!nextTarget) {
    memoryLogger.warn(
      `${logPrefix}: 没有更多可用目标${isStreamError ? '' : '，返回错误给客户端'}`,
      'Proxy'
    );
    return false;
  }

  memoryLogger.info(
    `${logPrefix}: 切换到新目标 provider=${nextTarget.providerId}`,
    'Proxy'
  );
  
  // 更新 request.body.model 如果有 override
  if (nextTarget.modelOverride) {
    (context.request.body as any).model = nextTarget.modelOverride;
  }
  
  // 重新构建 provider config
  const { buildProviderConfig } = await import('./provider-config-builder.js');
  const configResult = await buildProviderConfig(
    nextTarget.provider,
    context.virtualKey,
    context.vkDisplay,
    nextTarget.providerId,
    context.request,
    context.currentModel
  );
  
  if ('code' in configResult) {
    memoryLogger.error(
      `${logPrefix}: 构建配置失败`,
      'Proxy'
    );
    return false;
  }

  // 根据请求类型进行重试
  if (isStreamError) {
    const { handleStreamRequest } = await import('./proxy-handler.js');
    await handleStreamRequest(
      context.request,
      context.reply,
      configResult.protocolConfig,
      context.path,
      context.vkDisplay,
      context.virtualKey,
      nextTarget.providerId,
      context.startTime,
      context.compressionStats,
      context.currentModel,
      nextTarget.retryContext
    );
  } else {
    const { handleNonStreamRequest } = await import('./proxy-handler.js');
    await handleNonStreamRequest(
      context.request,
      context.reply,
      configResult.protocolConfig,
      context.virtualKey,
      nextTarget.providerId,
      context.isStreamRequest,
      context.path,
      context.startTime,
      context.compressionStats,
      context.currentModel,
      nextTarget.retryContext
    );
  }

  return true;
}

function shouldRetryLoadBalance(statusCode: number): boolean {
  // 对于 429 (rate limit), 503 (service unavailable), 500 (internal error) 等错误进行重试
  return statusCode === 429 || statusCode === 503 || statusCode === 500 || statusCode === 502 || statusCode === 504;
}