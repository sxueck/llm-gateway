import { FastifyRequest } from 'fastify';
import { decryptApiKey } from '../../utils/crypto.js';
import { memoryLogger } from '../../services/logger.js';
import { ProviderAdapterFactory } from '../../services/provider-adapter.js';
import { portkeyRouter } from '../../services/portkey-router.js';
import { isLocalGateway } from '../../utils/network.js';

export interface ProviderConfigResult {
  portkeyUrl: string;
  headers: Record<string, string>;
  path: string;
  vkDisplay: string;
  isStreamRequest: boolean;
  selectedGateway: any;
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

export function buildProviderConfig(
  provider: any,
  virtualKey: any,
  virtualKeyValue: string,
  providerId: string,
  request: FastifyRequest
): ProviderConfigResult | ProviderConfigError {
  const decryptedApiKey = decryptApiKey(provider.api_key);
  const baseUrl = provider.base_url || '';

  const normalized = ProviderAdapterFactory.normalizeProviderConfig({
    provider: provider.id,
    baseUrl,
    apiKey: decryptedApiKey,
  });

  const vkDisplay = virtualKeyValue && virtualKeyValue.length > 10
    ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
    : virtualKeyValue;

  const portkeyConfig: Record<string, any> = {
    provider: normalized.provider,
    api_key: normalized.apiKey,
  };

  if (normalized.baseUrl && normalized.provider.toLowerCase() !== 'google') {
    portkeyConfig.custom_host = normalized.baseUrl;
  }

  if (virtualKey.cache_enabled === 1) {
    memoryLogger.debug(
      `Gateway cache enabled | virtual key: ${vkDisplay}`,
      'Proxy'
    );
  }

  let path = request.url;
  if (path.startsWith('/v1/v1/')) {
    path = path.replace(/^\/v1\/v1\//, '/v1/');
    memoryLogger.debug(
      `Path normalized: ${request.url} -> ${path}`,
      'Proxy'
    );
  }

  if (!path.startsWith('/v1/')) {
    path = `/v1${path}`;
    memoryLogger.debug(
      `Path normalized to v1: ${request.url} -> ${path}`,
      'Proxy'
    );
  }

  if (path.startsWith('/v1/embeddings') && (request as any).body && typeof (request as any).body.input === 'string') {
    (request as any).body.input = [(request as any).body.input];
  }

  const routingContext = {
    modelName: (request.body as any)?.model,
    modelId: virtualKey.model_id || undefined,
    providerId: providerId,
    virtualKeyId: virtualKey.id,
  };

  const selectedGateway = portkeyRouter.selectGateway(routingContext);

  if (!selectedGateway) {
    memoryLogger.error('No Portkey Gateway available', 'Proxy');
    return {
      code: 503,
      body: {
        error: {
          message: 'No Portkey Gateway available, please configure in system settings',
          type: 'service_unavailable',
          param: null,
          code: 'no_gateway_available'
        }
      }
    };
  }

  const portkeyUrl = `${selectedGateway.url}${path}`;

  const isStreamRequest = (request.body as any)?.stream === true;

  const portkeyConfigJson = JSON.stringify(portkeyConfig);
  memoryLogger.debug(
    `Portkey config JSON: ${portkeyConfigJson}`,
    'Proxy'
  );
  memoryLogger.debug(
    `Portkey config JSON length: ${portkeyConfigJson.length} | bytes: ${Buffer.byteLength(portkeyConfigJson, 'utf8')}`,
    'Proxy'
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-portkey-config': portkeyConfigJson,
  };

  if (isStreamRequest) {
    headers['Accept'] = 'text/event-stream';
  }

  const isLocal = isLocalGateway(selectedGateway.url);
  if (!isLocal && selectedGateway.api_key) {
    headers['X-Gateway-ID'] = selectedGateway.id;
    headers['X-API-Key'] = selectedGateway.api_key;

    memoryLogger.debug(
      `Remote gateway request, auth headers added | gateway: ${selectedGateway.name}`,
      'Proxy'
    );
  } else if (isLocal) {
    memoryLogger.debug(
      `Local gateway request, direct mode | gateway: ${selectedGateway.name}`,
      'Proxy'
    );
  }

  Object.keys(request.headers).forEach(key => {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('x-') &&
        lowerKey !== 'x-portkey-virtual-key' &&
        lowerKey !== 'x-portkey-config' &&
        lowerKey !== 'x-gateway-id' &&
        lowerKey !== 'x-api-key') {
      headers[key] = request.headers[key] as string;
    }
  });

  const redactedConfig = { ...portkeyConfig };
  if (redactedConfig.api_key) {
    const k = redactedConfig.api_key;
    redactedConfig.api_key = k && k.length > 10 ? `${k.slice(0, 6)}...${k.slice(-4)}` : '***';
  }

  memoryLogger.info(
    `Proxy request: ${request.method} ${path} | virtual key: ${vkDisplay} | provider: ${providerId}`,
    'Proxy'
  );
  memoryLogger.debug(
    `Forward to Portkey: ${portkeyUrl} | config: ${JSON.stringify(redactedConfig)}`,
    'Proxy'
  );

  return {
    portkeyUrl,
    headers,
    path,
    vkDisplay,
    isStreamRequest,
    selectedGateway
  };
}

