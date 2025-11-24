import { FastifyRequest } from 'fastify';
import { decryptApiKey } from '../../utils/crypto.js';
import { memoryLogger } from '../../services/logger.js';
import { ProviderAdapterFactory } from '../../services/provider-adapter.js';
import { getBaseUrlForProtocol } from '../../utils/protocol-utils.js';
import type { ProtocolConfig } from '../../services/protocol-adapter.js';
import { normalizePath, isEmbeddingsPath } from '../../utils/path-detector.js';

export interface ProviderConfigResult {
  protocolConfig: ProtocolConfig;
  path: string;
  vkDisplay: string;
  isStreamRequest: boolean;
}

export interface ProviderConfigError {
  code: number;
  body: {
    error: {
      message: string;
      type: string;
      param: null;
      code: string;
    };
  };
}

export async function buildProviderConfig(
  provider: any,
  virtualKey: any,
  virtualKeyValue: string,
  providerId: string,
  request: FastifyRequest,
  currentModel?: any
): Promise<ProviderConfigResult | ProviderConfigError> {
  const decryptedApiKey = decryptApiKey(provider.api_key);

  // 协议优先级：currentModel.protocol（真实模型的协议）> 'openai'
  const effectiveProtocol = currentModel?.protocol || 'openai';
  const baseUrl = getBaseUrlForProtocol(provider, effectiveProtocol);

  memoryLogger.debug(
    `协议选择 | currentModel: ${currentModel?.name || 'none'} | currentModel.protocol: ${currentModel?.protocol || 'none'} | effectiveProtocol: ${effectiveProtocol} | baseUrl: ${baseUrl}`,
    'ProviderConfig'
  );

  const normalized = ProviderAdapterFactory.normalizeProviderConfig({
    provider: provider.id,
    baseUrl,
    apiKey: decryptedApiKey,
    protocol: effectiveProtocol,
  });

  const vkDisplay = virtualKeyValue && virtualKeyValue.length > 10
    ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
    : virtualKeyValue;

  if (virtualKey.cache_enabled === 1) {
    memoryLogger.debug(
      `缓存已启用 | virtual key: ${vkDisplay}`,
      'Proxy'
    );
  }

  let path = request.url;
  const normalizedPath = normalizePath(path);

  if (normalizedPath !== path) {
    memoryLogger.debug(
      `路径标准化: ${path} -> ${normalizedPath}`,
      'Proxy'
    );
    path = normalizedPath;
  }

  if (isEmbeddingsPath(path) && (request as any).body && typeof (request as any).body.input === 'string') {
    (request as any).body.input = [(request as any).body.input];
  }

  const isStreamRequest = (request.body as any)?.stream === true;
  const model = (request.body as any)?.model || 'unknown';

  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch (e) {
    }
  }

  const protocolConfig: ProtocolConfig = {
    provider: normalized.provider,
    apiKey: normalized.apiKey,
    baseUrl: normalized.baseUrl || undefined,
    model,
    protocol: normalized.protocol,
    modelAttributes,
  };

  const redactedApiKey = decryptedApiKey && decryptedApiKey.length > 10
    ? `${decryptedApiKey.slice(0, 6)}...${decryptedApiKey.slice(-4)}`
    : '***';

  memoryLogger.info(
    `代理请求: ${request.method} ${path} | virtual key: ${vkDisplay} | provider: ${providerId} | model: ${model}`,
    'Proxy'
  );
  memoryLogger.debug(
    `协议配置 | provider: ${normalized.provider} | protocol: ${normalized.protocol} | baseUrl: ${normalized.baseUrl || 'default'} | model: ${model} | apiKey: ${redactedApiKey}`,
    'Proxy'
  );

  return {
    protocolConfig,
    path,
    vkDisplay,
    isStreamRequest,
  };
}

