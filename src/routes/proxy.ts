import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { request as httpRequest, IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { virtualKeyDb, apiRequestDb, providerDb, modelDb, routingConfigDb } from '../db/index.js';
import { memoryLogger } from '../services/logger.js';
import { decryptApiKey } from '../utils/crypto.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse } from '../utils/request-logger.js';
import { portkeyRouter } from '../services/portkey-router.js';
import { requestCache } from '../services/request-cache.js';
import { ProviderAdapterFactory } from '../services/provider-adapter.js';
import { isLocalGateway } from '../utils/network.js';

interface RoutingTarget {
  provider: string;
  weight?: number;
  override_params?: {
    model?: string;
    [key: string]: any;
  };
  on_status_codes?: number[];
}

interface RoutingConfig {
  strategy: {
    mode: 'loadbalance' | 'fallback';
  };
  targets: RoutingTarget[];
}

let routingTargetIndex = 0;

function selectRoutingTarget(config: RoutingConfig, type: string): RoutingTarget | null {
  if (!config.targets || config.targets.length === 0) {
    return null;
  }

  if (type === 'loadbalance' || config.strategy?.mode === 'loadbalance') {
    const targets = config.targets.filter(t => t.weight && t.weight > 0);
    if (targets.length === 0) {
      return config.targets[0];
    }

    const totalWeight = targets.reduce((sum, t) => sum + (t.weight || 0), 0);
    let random = Math.random() * totalWeight;

    for (const target of targets) {
      random -= target.weight || 0;
      if (random <= 0) {
        return target;
      }
    }

    return targets[0];
  }

  if (type === 'fallback' || config.strategy?.mode === 'fallback') {
    routingTargetIndex = (routingTargetIndex + 1) % config.targets.length;
    return config.targets[routingTargetIndex];
  }

  return config.targets[0];
}

interface ResolveSmartRoutingResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
}

function resolveSmartRouting(
  model: any
): ResolveSmartRoutingResult | null {
  if (model.is_virtual !== 1 || !model.routing_config_id) {
    return null;
  }

  const routingConfig = routingConfigDb.getById(model.routing_config_id);
  if (!routingConfig) {
    memoryLogger.error(`Smart routing config not found: ${model.routing_config_id}`, 'Proxy');
    throw new Error('Smart routing config not found');
  }

  try {
    const config = JSON.parse(routingConfig.config);
    const selectedTarget = selectRoutingTarget(config, routingConfig.type);

    if (!selectedTarget) {
      memoryLogger.error(`No target selected from smart routing config: ${model.routing_config_id}`, 'Proxy');
      throw new Error('No available target in smart routing config');
    }

    const provider = providerDb.getById(selectedTarget.provider);
    if (!provider) {
      memoryLogger.error(`Smart routing target provider not found: ${selectedTarget.provider}`, 'Proxy');
      throw new Error('Smart routing target provider not found');
    }

    const result: ResolveSmartRoutingResult = {
      provider,
      providerId: selectedTarget.provider
    };

    if (selectedTarget.override_params?.model) {
      result.modelOverride = selectedTarget.override_params.model;
      memoryLogger.debug(
        `Smart routing model override: ${selectedTarget.override_params.model}`,
        'Proxy'
      );
    }

    memoryLogger.info(
      `Smart routing target selected: provider=${provider.name} | model=${selectedTarget.override_params?.model || 'default'}`,
      'Proxy'
    );

    return result;
  } catch (e: any) {
    memoryLogger.error(`Failed to parse smart routing config: ${e.message}`, 'Proxy');
    throw new Error(`Smart routing config parse error: ${e.message}`);
  }
}

interface ResolveProviderResult {
  provider: any;
  providerId: string;
}

function resolveProviderFromModel(
  model: any,
  request: ProxyRequest
): ResolveProviderResult {
  const smartRoutingResult = resolveSmartRouting(model);
  if (smartRoutingResult) {
    if (smartRoutingResult.modelOverride) {
      request.body = request.body || {};
      request.body.model = smartRoutingResult.modelOverride;
    }
    return {
      provider: smartRoutingResult.provider,
      providerId: smartRoutingResult.providerId
    };
  }

  if (!model.provider_id) {
    throw new Error('Model has no provider configured');
  }

  const provider = providerDb.getById(model.provider_id);
  if (!provider) {
    memoryLogger.error(`Provider not found: ${model.provider_id}`, 'Proxy');
    throw new Error('Provider config not found');
  }

  return {
    provider,
    providerId: model.provider_id
  };
}

function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? httpsRequest : httpRequest;

    const options: any = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

    if (isHttps) {
      options.rejectUnauthorized = false;
    }

    const req = requestModule(options, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode || 500,
          headers: res.headers as Record<string, string | string[]>,
          body: responseBody,
        });
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(body, 'utf-8');
    }

    req.end();
  });
}

function makeStreamHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  reply: FastifyReply
): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; streamChunks: string[] }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const requestModule = isHttps ? httpsRequest : httpRequest;

    const options: any = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

    if (isHttps) {
      options.rejectUnauthorized = false;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let buffer = '';
    const streamChunks: string[] = [];

    const req = requestModule(options, (res: IncomingMessage) => {

      reply.raw.writeHead(res.statusCode || 200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });

      res.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf-8');
        buffer += chunkStr;
        streamChunks.push(chunkStr);

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
            try {
              const jsonStr = line.substring(6).trim();
              if (jsonStr) {
                const data = JSON.parse(jsonStr);
                if (data.usage) {
                  promptTokens = data.usage.prompt_tokens || promptTokens;
                  completionTokens = data.usage.completion_tokens || completionTokens;
                  totalTokens = data.usage.total_tokens || totalTokens;
                }
              }
            } catch {
            }
          }
        }

        reply.raw.write(chunk);
      });

      res.on('end', () => {
        reply.raw.end();
        resolve({ promptTokens, completionTokens, totalTokens, streamChunks });
      });

      res.on('error', (err: any) => {
        reject(err);
      });
    });

    req.on('error', (err: any) => {
      reject(err);
    });

    if (body) {
      req.write(body, 'utf-8');
    }

    req.end();
  });
}



interface ProxyRequest extends FastifyRequest {
  body: any;
}

export async function proxyRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/models', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: {
            message: 'Missing authentication',
            type: 'invalid_request_error',
            param: null,
            code: 'missing_authorization'
          }
        });
      }

      const virtualKeyValue = authHeader.substring(7);
      const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);

      if (!virtualKey) {
        memoryLogger.warn(`Virtual key not found: ${virtualKeyValue}`, 'Proxy');
        return reply.code(401).send({
          error: {
            message: 'Invalid virtual key',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        });
      }

      if (!virtualKey.enabled) {
        memoryLogger.warn(`Virtual key disabled: ${virtualKeyValue}`, 'Proxy');
        return reply.code(403).send({
          error: {
            message: 'Virtual key has been disabled',
            type: 'invalid_request_error',
            param: null,
            code: 'api_key_disabled'
          }
        });
      }

      const modelIds: string[] = [];

      if (virtualKey.model_id) {
        modelIds.push(virtualKey.model_id);
      }

      if (virtualKey.model_ids) {
        try {
          const parsedModelIds = JSON.parse(virtualKey.model_ids);
          if (Array.isArray(parsedModelIds)) {
            modelIds.push(...parsedModelIds);
          }
        } catch (e) {
          memoryLogger.error(`Failed to parse model_ids: ${e}`, 'Proxy');
        }
      }

      const uniqueModelIds = [...new Set(modelIds)];
      const models = uniqueModelIds
        .map(id => modelDb.getById(id))
        .filter(model => model?.enabled);

      const modelList = models.map(model => {
        const baseInfo: any = {
          id: model!.is_virtual ? model!.name : model!.model_identifier,
          object: 'model',
          created: Math.floor(model!.created_at / 1000),
          owned_by: 'system'
        };

        if (model!.model_attributes) {
          try {
            const attributes = JSON.parse(model!.model_attributes);
            Object.assign(baseInfo, attributes);
          } catch (e) {
          }
        }

        return baseInfo;
      });

      memoryLogger.info(
        `Models list query: virtual key ${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)} | returned ${modelList.length} models`,
        'Proxy'
      );

      return reply.send({
        object: 'list',
        data: modelList
      });
    } catch (error: any) {
      memoryLogger.error(
        `Models list query failed: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      return reply.code(500).send({
        error: {
          message: error.message || 'Failed to query models list',
          type: 'internal_error',
          param: null,
          code: 'models_list_error'
        }
      });
    }
  });

  fastify.all('/v1/*', async (request: ProxyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;

    try {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: {
            message: 'Missing authentication',
            type: 'invalid_request_error',
            param: null,
            code: 'missing_authorization'
          }
        });
      }

      virtualKeyValue = authHeader.substring(7);

      const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);
      if (!virtualKey) {
        memoryLogger.warn(`Virtual key not found: ${virtualKeyValue}`, 'Proxy');
        return reply.code(401).send({
          error: {
            message: 'Invalid virtual key',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        });
      }

      if (!virtualKey.enabled) {
        memoryLogger.warn(`Virtual key disabled: ${virtualKeyValue}`, 'Proxy');
        return reply.code(403).send({
          error: {
            message: 'Virtual key has been disabled',
            type: 'invalid_request_error',
            param: null,
            code: 'api_key_disabled'
          }
        });
      }

      let provider;

      if (virtualKey.model_id) {
        const model = modelDb.getById(virtualKey.model_id);
        if (!model) {
          memoryLogger.error(`Model not found: ${virtualKey.model_id}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: 'Model config not found',
              type: 'internal_error',
              param: null,
              code: 'model_not_found'
            }
          });
        }

        try {
          const result = resolveProviderFromModel(model, request);
          provider = result.provider;
          providerId = result.providerId;
        } catch (routingError: any) {
          memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: routingError.message || 'Smart routing failed',
              type: 'internal_error',
              param: null,
              code: 'smart_routing_error'
            }
          });
        }
      } else if (virtualKey.model_ids) {
        try {
          const parsedModelIds = JSON.parse(virtualKey.model_ids);
          if (!Array.isArray(parsedModelIds) || parsedModelIds.length === 0) {
            memoryLogger.error(`Invalid model_ids config for virtual key: ${virtualKeyValue}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: 'Invalid virtual key model config',
                type: 'internal_error',
                param: null,
                code: 'invalid_model_config'
              }
            });
          }

          const requestedModel = request.body?.model;
          let targetModelId: string | undefined;

          if (requestedModel) {
            for (const modelId of parsedModelIds) {
              const model = modelDb.getById(modelId);
              if (model && (model.model_identifier === requestedModel || model.name === requestedModel)) {
                targetModelId = modelId;
                break;
              }
            }
          }

          if (!targetModelId) {
            targetModelId = parsedModelIds[0];
          }

          if (!targetModelId) {
            memoryLogger.error(`Cannot determine target model`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: 'Cannot determine target model',
                type: 'internal_error',
                param: null,
                code: 'model_not_determined'
              }
            });
          }

          const model = modelDb.getById(targetModelId);
          if (!model) {
            memoryLogger.error(`Model not found: ${targetModelId}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: 'Model config not found',
                type: 'internal_error',
                param: null,
                code: 'model_not_found'
              }
            });
          }

          try {
            const result = resolveProviderFromModel(model, request);
            provider = result.provider;
            providerId = result.providerId;
          } catch (routingError: any) {
            memoryLogger.error(`Smart routing failed: ${routingError.message}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: routingError.message || 'Smart routing failed',
                type: 'internal_error',
                param: null,
                code: 'smart_routing_error'
              }
            });
          }
        } catch (e) {
          memoryLogger.error(`Failed to parse model_ids: ${e}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: 'Failed to parse virtual key model config',
              type: 'internal_error',
              param: null,
              code: 'model_config_parse_error'
            }
          });
        }
      } else if (virtualKey.provider_id) {
        provider = providerDb.getById(virtualKey.provider_id);
        if (!provider) {
          memoryLogger.error(`Provider not found: ${virtualKey.provider_id}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: 'Provider config not found',
              type: 'internal_error',
              param: null,
              code: 'provider_not_found'
            }
          });
        }

        providerId = virtualKey.provider_id;
      } else {
        memoryLogger.error(`Virtual key has no model or provider configured: ${virtualKeyValue}`, 'Proxy');
        return reply.code(500).send({
          error: {
            message: 'Incomplete virtual key config',
            type: 'internal_error',
            param: null,
            code: 'invalid_key_config'
          }
        });
      }

      if (!provider) {
        memoryLogger.error(`Provider not found`, 'Proxy');
        return reply.code(500).send({
          error: {
            message: 'Provider config not found',
            type: 'internal_error',
            param: null,
            code: 'provider_not_found'
          }
        });
      }

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

      const path = request.url.startsWith('/v1/') ? request.url : `/v1${request.url}`;


      if (path.startsWith('/v1/embeddings') && (request as any).body && typeof (request as any).body.input === 'string') {
        (request as any).body.input = [(request as any).body.input];
      }

      const routingContext = {
        modelName: request.body?.model,
        modelId: virtualKey.model_id || undefined,
        providerId: providerId,
        virtualKeyId: virtualKey.id,
      };

      const selectedGateway = portkeyRouter.selectGateway(routingContext);

      if (!selectedGateway) {
        memoryLogger.error('No Portkey Gateway available', 'Proxy');
        return reply.code(503).send({
          error: {
            message: 'No Portkey Gateway available, please configure in system settings',
            type: 'service_unavailable',
            param: null,
            code: 'no_gateway_available'
          }
        });
      }

      const portkeyUrl = `${selectedGateway.url}${path}`;

      const isStreamRequest = request.body?.stream === true;

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

      let requestBody: string | undefined;

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestBody = JSON.stringify(request.body);
        const truncatedBody = requestBody.length > 500
          ? `${requestBody.substring(0, 500)}... (total length: ${requestBody.length} chars)`
          : requestBody;
        memoryLogger.debug(
          `Request body: ${truncatedBody}`,
          'Proxy'
        );
      }

      memoryLogger.debug(
        `Forward request: ${request.method} ${portkeyUrl} | stream: ${isStreamRequest}`,
        'Proxy'
      );

      if (isStreamRequest) {
        memoryLogger.info(
          `Stream request started: ${path} | virtual key: ${vkDisplay}`,
          'Proxy'
        );

        try {
          const tokenUsage = await makeStreamHttpRequest(
            portkeyUrl,
            request.method,
            headers,
            requestBody,
            reply
          );

          const duration = Date.now() - startTime;
          memoryLogger.info(
            `Stream request completed: ${duration}ms | tokens: ${tokenUsage.totalTokens}`,
            'Proxy'
          );



          const truncatedRequest = truncateRequestBody(request.body);
          const truncatedResponse = accumulateStreamResponse(tokenUsage.streamChunks);

          apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: request.body?.model || 'unknown',
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens,
            status: 'success',
            response_time: duration,
            error_message: undefined,
            request_body: truncatedRequest,
            response_body: truncatedResponse,
            cache_hit: 0,
            prompt_cache_hit_tokens: 0,
            prompt_cache_write_tokens: 0,
          });

          return;
        } catch (streamError: any) {
          const duration = Date.now() - startTime;
          memoryLogger.error(
            `Stream request failed: ${streamError.message}`,
            'Proxy',
            { error: streamError.stack }
          );



          const truncatedRequest = truncateRequestBody(request.body);

          apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: request.body?.model || 'unknown',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            status: 'error',
            response_time: duration,
            error_message: streamError.message,
            request_body: truncatedRequest,
            response_body: undefined,
          });

          throw streamError;
        }
      }

      let cacheKey: string | null = null;
      let fromCache = false;

      const isEmbeddingsRequest = path.startsWith('/v1/embeddings');
      const shouldCache = virtualKey.cache_enabled === 1 && !isStreamRequest && !isEmbeddingsRequest && request.body;

      if (isEmbeddingsRequest && virtualKey.cache_enabled === 1) {
        memoryLogger.debug(
          `Embeddings request cache disabled | virtual key: ${vkDisplay}`,
          'Proxy'
        );
      }

      if (shouldCache) {
        cacheKey = requestCache.generateCacheKey(request.body);
        const cached = requestCache.get(cacheKey);

        if (cached) {
          fromCache = true;
          reply.headers({
            ...cached.headers,
            'X-Cache-Status': 'HIT'
          });
          reply.code(200);

          const duration = Date.now() - startTime;
          const truncatedRequest = truncateRequestBody(request.body);

          apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: request.body?.model || 'unknown',
            prompt_tokens: cached.response.usage?.prompt_tokens || 0,
            completion_tokens: cached.response.usage?.completion_tokens || 0,
            total_tokens: cached.response.usage?.total_tokens || 0,
            status: 'success',
            response_time: duration,
            error_message: undefined,
            request_body: truncatedRequest,
            response_body: truncateResponseBody(cached.response),
            cache_hit: 1,
            prompt_cache_hit_tokens: 0,
            prompt_cache_write_tokens: 0,
          });

          memoryLogger.info(
            `Request completed: 200 | ${duration}ms | tokens: ${cached.response.usage?.total_tokens || 0} | cache hit`,
            'Proxy'
          );

          return reply.send(cached.response);
        }

        memoryLogger.debug(
          `Cache miss | key=${cacheKey.substring(0, 8)}... | virtual key: ${vkDisplay}`,
          'Proxy'
        );
      }

      const response = await makeHttpRequest(
        portkeyUrl,
        (request as any).method,
        headers,
        requestBody
      );

      const responseHeaders: Record<string, string> = {};
      Object.entries(response.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (!lowerKey.startsWith('transfer-encoding') &&
            !lowerKey.startsWith('connection') &&
            lowerKey !== 'content-length' &&
            lowerKey !== 'content-type') {
          responseHeaders[key] = Array.isArray(value) ? value[0] : value;
        }
      });

      reply.headers(responseHeaders);
      reply.code(response.statusCode);

      let responseData: any;
      const responseText = response.body;

      const truncatedResponseText = responseText.length > 500
        ? `${responseText.substring(0, 500)}... (total length: ${responseText.length} chars)`
        : responseText;

      memoryLogger.debug(
        `Raw response body: ${truncatedResponseText}`,
        'Proxy'
      );

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const isJsonResponse = contentType.includes('application/json') || contentType.includes('json');

      if (!isJsonResponse && responseText) {
        memoryLogger.warn(
          `Upstream returned non-JSON response: Content-Type=${contentType}`,
          'Proxy'
        );
        reply.header('Content-Type', contentType || 'text/plain');
        return reply.send(responseText);
      }

      try {
        responseData = responseText ? JSON.parse(responseText) : { error: { message: 'Empty response body' } };

        const responseDataStr = JSON.stringify(responseData);
        let logMessage = '';

        if (responseDataStr.length > 1000) {
          const summary = {
            id: responseData.id,
            model: responseData.model,
            choices_count: responseData.choices?.length || 0,
            first_message_preview: responseData.choices?.[0]?.message?.content?.substring(0, 100),
            usage: responseData.usage,
            total_length: responseDataStr.length
          };
          logMessage = `Response summary: ${JSON.stringify(summary)}`;
        } else {
          logMessage = `Full response: ${responseDataStr}`;
        }

        memoryLogger.debug(logMessage, 'Proxy');
      } catch (parseError) {
        memoryLogger.error(
          `JSON parse failed: ${parseError} | first 200 chars: ${responseText.substring(0, 200)}`,
          'Proxy'
        );
        responseData = {
          error: {
            message: 'Invalid JSON response from upstream',
            type: 'api_error',
            param: null,
            code: 'invalid_response',
            upstream_response: responseText.substring(0, 1000)
          }
        };
      }

        const duration = Date.now() - startTime;
      const usage = responseData.usage || {};
      const isSuccess = response.statusCode >= 200 && response.statusCode < 300;

      const truncatedRequest = truncateRequestBody(request.body);
      const truncatedResponse = truncateResponseBody(responseData);

      apiRequestDb.create({
        id: nanoid(),
        virtual_key_id: virtualKey.id,
        provider_id: providerId,
        model: request.body?.model || 'unknown',
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        status: isSuccess ? 'success' : 'error',
        response_time: duration,
        error_message: isSuccess ? undefined : JSON.stringify(responseData),
        request_body: truncatedRequest,
        response_body: truncatedResponse,
        cache_hit: fromCache ? 1 : 0,
        prompt_cache_hit_tokens: usage.prompt_tokens_details?.cached_tokens || usage.prompt_cache_hit_tokens || 0,
        prompt_cache_write_tokens: usage.prompt_tokens_details?.cached_tokens_write || usage.prompt_cache_write_tokens || 0,
      });

      if (isSuccess) {
        if (cacheKey && shouldCache && !fromCache) {
          const cacheHeaders: Record<string, string> = { ...responseHeaders };
          requestCache.set(cacheKey, responseData, cacheHeaders);
          reply.header('X-Cache-Status', 'MISS');

          memoryLogger.debug(
            `Response cached | key=${cacheKey.substring(0, 8)}... | model=${request.body?.model}`,
            'Proxy'
          );
        }

        let cacheStatus: string;
        if (fromCache) {
          cacheStatus = 'cache hit';
        } else if (shouldCache) {
          cacheStatus = 'cache miss';
        } else {
          cacheStatus = 'cache disabled';
        }
        memoryLogger.info(
          `Request completed: ${response.statusCode} | ${duration}ms | tokens: ${usage.total_tokens || 0} | ${cacheStatus}`,
          'Proxy'
        );
      } else {
        const errorStr = JSON.stringify(responseData);
        const truncatedError = errorStr.length > 500
          ? `${errorStr.substring(0, 500)}... (total length: ${errorStr.length} chars)`
          : errorStr;
        memoryLogger.error(
          `Request failed: ${response.statusCode} | ${duration}ms | error: ${truncatedError}`,
          'Proxy'
        );


      }

      reply.header('Content-Type', 'application/json');

      memoryLogger.debug(
        `Response structure sent to client: ${JSON.stringify({
          has_id: !!responseData.id,
          has_object: !!responseData.object,
          object_value: responseData.object,
          has_choices: !!responseData.choices,
          choices_length: responseData.choices?.length,
          has_message: !!responseData.choices?.[0]?.message,
          message_role: responseData.choices?.[0]?.message?.role,
          message_content_length: responseData.choices?.[0]?.message?.content?.length,
          has_tool_calls: !!responseData.choices?.[0]?.message?.tool_calls,
          tool_calls_length: responseData.choices?.[0]?.message?.tool_calls?.length,
          has_usage: !!responseData.usage,
          usage: responseData.usage,
        })}`,
        'Proxy'
      );

      return reply.send(responseData);
    } catch (error: any) {
      const duration = Date.now() - startTime;

      memoryLogger.error(
        `Proxy request failed: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      if (virtualKeyValue && providerId) {
        const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);
        if (virtualKey) {
          const truncatedRequest = truncateRequestBody(request.body);

          apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: request.body?.model || 'unknown',
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            status: 'error',
            response_time: duration,
            error_message: error.message,
            request_body: truncatedRequest,
            response_body: undefined,
          });
        }
      }

      return reply.code(500).send({
        error: {
          message: error.message || '代理请求失败',
          type: 'internal_error',
          param: null,
          code: 'proxy_error'
        }
      });
    }
  });

  setInterval(() => {
    requestCache.logStats();
  }, 3600000);
}

