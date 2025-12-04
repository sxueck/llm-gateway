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

function deriveGoogleNativeBaseUrl(baseUrl?: string | null): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  let nativeBase = baseUrl.trim();
  if (!nativeBase) {
    return undefined;
  }

  nativeBase = nativeBase.replace(/\/+$/, '');
  if (!nativeBase) {
    return undefined;
  }

  nativeBase = nativeBase.replace(/\/v1beta\/openai$/i, '');
  nativeBase = nativeBase.replace(/\/v1beta$/i, '');
  nativeBase = nativeBase.replace(/\/+$/, '');

  return nativeBase || undefined;
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

  // 提取纯路径和查询参数部分，因为 request.url 可能包含查询字符串
  // 例如：/v1beta/models/gemini-2.0-flash:generateContent?alt=sse ->
  // path=/v1beta/models/gemini-2.0-flash:generateContent, query=alt=sse
  const [rawPath, rawQuery = ''] = request.url.split('?');
  let path = rawPath || '/';
  const normalizedPath = normalizePath(path);

  if (normalizedPath !== path) {
    memoryLogger.debug(
      `路径标准化: ${path} -> ${normalizedPath}`,
      'Proxy'
    );
    path = normalizedPath;
  }

  // 判断是否为 Gemini 原生请求（/v1beta/models/*）
  const isGeminiNativeRequest = normalizedPath.startsWith('/v1beta/models/');

  // 通过路径或查询参数判断是否为流式 Gemini 请求
  const isGeminiStreamByPath = /:streamGenerateContent$/i.test(normalizedPath);
  const isGeminiStreamByQuery = /(^|&)alt=sse(&|$)/i.test(rawQuery);

  // 协议优先级：
  // - 对于 Gemini 原生路径，强制使用 google 协议，走 Gemini 透传逻辑
  // - 其他情况复用模型配置的协议，默认为 openai
  const effectiveProtocol: 'openai' | 'anthropic' | 'google' =
    isGeminiNativeRequest ? 'google' : (currentModel?.protocol || 'openai');

  const baseUrl = getBaseUrlForProtocol(provider, effectiveProtocol);
  const originalBaseUrl = baseUrl;

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

  if (isEmbeddingsPath(path) && (request as any).body && typeof (request as any).body.input === 'string') {
    (request as any).body.input = [(request as any).body.input];
  }

  // 流式请求判断：
  // - OpenAI 兼容路径依然通过 body.stream === true 判断
  // - Gemini 原生路径通过 URL 中的 :streamGenerateContent 或 alt=sse 判断
  const isStreamRequest = (request.body as any)?.stream === true || isGeminiStreamByPath || isGeminiStreamByQuery;

  // 模型名称获取优先级：
  // 1. 请求体中的 model 字段（OpenAI 格式）
  // 2. 从路径中提取（Gemini 格式：/v1beta/models/{model}:generateContent）
  // 3. currentModel.model_identifier（配置的真实模型标识符）
  // 4. 默认为 'unknown'
  let model = (request.body as any)?.model;

  // 对于 Gemini 原生请求，从路径中提取模型名称
  if (!model && (effectiveProtocol === 'google' || path.includes('/v1beta/models/'))) {
    // 尝试从路径中提取 Gemini 模型名称
    // 路径格式：/v1beta/models/gemini-2.0-flash:generateContent 或 /v1beta/models/gemini-2.0-flash:streamGenerateContent
    const pathMatch = path.match(/\/models\/([^:\/]+)/);
    if (pathMatch && pathMatch[1]) {
      model = pathMatch[1];
      // 重要：将提取的模型名称注入到请求体中，以便 model-resolver 能正确匹配
      if (request.body && typeof request.body === 'object') {
        (request.body as any).model = model;
      }
      memoryLogger.debug(
        `从路径提取 Gemini 模型名称并注入请求体: ${model}`,
        'ProviderConfig'
      );
    }
  }

  if (!model && currentModel) {
    model = currentModel.model_identifier || currentModel.name;
    memoryLogger.debug(
      `使用配置的模型标识符: ${model}`,
      'ProviderConfig'
    );
  }

  if (!model) {
    model = 'unknown';
  }

  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch (e) {
    }
  }

  const nativeBaseUrl = normalized.protocol === 'google'
    ? deriveGoogleNativeBaseUrl(originalBaseUrl || normalized.baseUrl)
    : undefined;

  const protocolConfig: ProtocolConfig = {
    provider: normalized.provider,
    apiKey: normalized.apiKey,
    baseUrl: normalized.baseUrl || undefined,
    nativeBaseUrl,
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
