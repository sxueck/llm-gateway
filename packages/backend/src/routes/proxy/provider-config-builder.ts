import { FastifyRequest } from 'fastify';
import { decryptApiKey } from '../../utils/crypto.js';
import { memoryLogger } from '../../services/logger.js';
import { ProviderAdapterFactory } from '../../services/provider-adapter.js';
import { getBaseUrlForProtocol, parseSupportedProtocols } from '../../utils/protocol-utils.js';
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
  currentModel?: any,
  entrypointProtocol?: 'openai' | 'anthropic' | 'gemini'
): Promise<ProviderConfigResult | ProviderConfigError> {
  const decryptedApiKey = decryptApiKey(provider.api_key);

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

  const isGeminiNativeRequest = normalizedPath.startsWith('/v1beta/models/');
  const isGeminiStreamByPath = /:streamGenerateContent$/i.test(normalizedPath);
  const isGeminiStreamByQuery = /(^|&)alt=sse(&|$)/i.test(rawQuery);

  // Map entrypoint protocol to effective upstream protocol
  let effectiveProtocol: 'openai' | 'anthropic' | 'google';
  if (entrypointProtocol === 'gemini') {
    effectiveProtocol = 'google';
  } else if (entrypointProtocol) {
    effectiveProtocol = entrypointProtocol;
  } else if (isGeminiNativeRequest) {
    effectiveProtocol = 'google';
  } else {
    effectiveProtocol = 'openai';
  }

  // Validate final resolved model's supported protocols whitelist
  if (currentModel) {
    const supported = parseSupportedProtocols(currentModel.supported_protocols);
    if (!supported.includes(effectiveProtocol)) {
      return {
        code: 400,
        body: {
          error: {
            message: `Model "${currentModel.name}" does not support protocol "${effectiveProtocol}". Supported protocols: ${supported.join(', ')}`,
            type: 'invalid_request_error',
            param: null,
            code: 'unsupported_model_protocol',
          },
        },
      };
    }
  }

  const baseUrl = getBaseUrlForProtocol(provider, effectiveProtocol);
  const originalBaseUrl = baseUrl;

  memoryLogger.debug(
    `协议选择 | currentModel: ${currentModel?.name || 'none'} | effectiveProtocol: ${effectiveProtocol} | baseUrl: ${baseUrl}`,
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

  const isStreamRequest = (request.body as any)?.stream === true || isGeminiStreamByPath || isGeminiStreamByQuery;

  let model = (request.body as any)?.model;

  if (!model && (effectiveProtocol === 'google' || path.includes('/v1beta/models/'))) {
    const pathMatch = path.match(/\/models\/([^:\/]+)/);
    if (pathMatch && pathMatch[1]) {
      model = pathMatch[1];
      memoryLogger.debug(
        `从路径提取 Gemini 模型名称: ${model}`,
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

  // 真实模型统一映射为 model_identifier 再发往上游（与重试路径 retry-handler 的行为一致）。
  // name 是对外展示名，客户端用 name 请求时不能把 name 原样透传给上游。
  // 虚拟模型的 identifier 是内部名（virtual-*/expert-*），其上游模型名由路由
  // override_params.model 改写 request.body.model 完成，此处必须跳过。
  if (
    currentModel &&
    currentModel.is_virtual !== 1 &&
    currentModel.model_identifier &&
    model !== currentModel.model_identifier
  ) {
    memoryLogger.debug(
      `模型名映射: ${model || '(empty)'} -> ${currentModel.model_identifier}`,
      'ProviderConfig'
    );
    model = currentModel.model_identifier;
  }

  if (!model) {
    model = 'unknown';
  }

  let modelAttributes: any = undefined;
  if (currentModel?.model_attributes) {
    try {
      modelAttributes = JSON.parse(currentModel.model_attributes);
    } catch {
      // model_attributes 不是合法 JSON 时按无属性处理，不阻断转发
    }
  }

  const nativeBaseUrl = normalized.protocol === 'google'
    ? deriveGoogleNativeBaseUrl(originalBaseUrl || normalized.baseUrl)
    : undefined;

  const upstreamTransport: ProtocolConfig['upstreamTransport'] =
    modelAttributes?.upstream_transport === 'websocket' || modelAttributes?.upstream_websocket_enabled === true
      ? 'websocket'
      : 'http_sse';

  const protocolConfig: ProtocolConfig = {
    provider: normalized.provider,
    apiKey: normalized.apiKey,
    baseUrl: normalized.baseUrl || undefined,
    nativeBaseUrl,
    model,
    protocol: normalized.protocol,
    modelAttributes,
    upstreamTransport,
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
