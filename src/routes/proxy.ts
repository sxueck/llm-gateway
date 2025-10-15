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
    memoryLogger.error(`智能路由配置不存在: ${model.routing_config_id}`, 'Proxy');
    throw new Error('智能路由配置不存在');
  }

  try {
    const config = JSON.parse(routingConfig.config);
    const selectedTarget = selectRoutingTarget(config, routingConfig.type);

    if (!selectedTarget) {
      memoryLogger.error(`无法从智能路由配置中选择目标: ${model.routing_config_id}`, 'Proxy');
      throw new Error('智能路由配置无可用目标');
    }

    const provider = providerDb.getById(selectedTarget.provider);
    if (!provider) {
      memoryLogger.error(`智能路由目标提供商不存在: ${selectedTarget.provider}`, 'Proxy');
      throw new Error('智能路由目标提供商不存在');
    }

    const result: ResolveSmartRoutingResult = {
      provider,
      providerId: selectedTarget.provider
    };

    if (selectedTarget.override_params?.model) {
      result.modelOverride = selectedTarget.override_params.model;
      memoryLogger.debug(
        `智能路由覆盖模型参数: ${selectedTarget.override_params.model}`,
        'Proxy'
      );
    }

    memoryLogger.info(
      `智能路由选择目标: 提供商=${provider.name} | 模型=${selectedTarget.override_params?.model || 'default'}`,
      'Proxy'
    );

    return result;
  } catch (e: any) {
    memoryLogger.error(`解析智能路由配置失败: ${e.message}`, 'Proxy');
    throw new Error(`智能路由配置解析失败: ${e.message}`);
  }
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

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

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

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      insecureHTTPParser: true,
    };

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

function getPortkeyProviderType(baseUrl: string): string {
  const url = baseUrl.toLowerCase();

  if (url.includes('api.deepseek.com')) {
    return 'openai';
  }
  if (url.includes('api.openai.com')) {
    return 'openai';
  }
  if (url.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (url.includes('generativelanguage.googleapis.com')) {
    return 'google';
  }

  return 'openai';
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
            message: '缺少认证信息',
            type: 'invalid_request_error',
            param: null,
            code: 'missing_authorization'
          }
        });
      }

      const virtualKeyValue = authHeader.substring(7);
      const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);

      if (!virtualKey) {
        memoryLogger.warn(`虚拟密钥不存在: ${virtualKeyValue}`, 'Proxy');
        return reply.code(401).send({
          error: {
            message: '无效的虚拟密钥',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        });
      }

      if (!virtualKey.enabled) {
        memoryLogger.warn(`虚拟密钥已禁用: ${virtualKeyValue}`, 'Proxy');
        return reply.code(403).send({
          error: {
            message: '虚拟密钥已被禁用',
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
          memoryLogger.error(`解析 model_ids 失败: ${e}`, 'Proxy');
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
            // 忽略解析错误
          }
        }

        return baseInfo;
      });

      memoryLogger.info(
        `模型列表查询: 虚拟密钥 ${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)} | 返回 ${modelList.length} 个模型`,
        'Proxy'
      );

      return reply.send({
        object: 'list',
        data: modelList
      });
    } catch (error: any) {
      memoryLogger.error(
        `模型列表查询失败: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      return reply.code(500).send({
        error: {
          message: error.message || '查询模型列表失败',
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
            message: '缺少认证信息',
            type: 'invalid_request_error',
            param: null,
            code: 'missing_authorization'
          }
        });
      }

      virtualKeyValue = authHeader.substring(7);

      const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);
      if (!virtualKey) {
        memoryLogger.warn(`虚拟密钥不存在: ${virtualKeyValue}`, 'Proxy');
        return reply.code(401).send({
          error: {
            message: '无效的虚拟密钥',
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_api_key'
          }
        });
      }

      if (!virtualKey.enabled) {
        memoryLogger.warn(`虚拟密钥已禁用: ${virtualKeyValue}`, 'Proxy');
        return reply.code(403).send({
          error: {
            message: '虚拟密钥已被禁用',
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
          memoryLogger.error(`模型不存在: ${virtualKey.model_id}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: '模型配置不存在',
              type: 'internal_error',
              param: null,
              code: 'model_not_found'
            }
          });
        }

        try {
          const smartRoutingResult = resolveSmartRouting(model);
          if (smartRoutingResult) {
            provider = smartRoutingResult.provider;
            providerId = smartRoutingResult.providerId;
            if (smartRoutingResult.modelOverride) {
              request.body = request.body || {};
              request.body.model = smartRoutingResult.modelOverride;
            }
          } else if (model.provider_id) {
            provider = providerDb.getById(model.provider_id);
            if (!provider) {
              memoryLogger.error(`提供商不存在: ${model.provider_id}`, 'Proxy');
              return reply.code(500).send({
                error: {
                  message: '提供商配置不存在',
                  type: 'internal_error',
                  param: null,
                  code: 'provider_not_found'
                }
              });
            }

            providerId = model.provider_id;
          }
        } catch (routingError: any) {
          memoryLogger.error(`智能路由失败: ${routingError.message}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: routingError.message || '智能路由失败',
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
            memoryLogger.error(`虚拟密钥 model_ids 配置无效: ${virtualKeyValue}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: '虚拟密钥模型配置无效',
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
            memoryLogger.error(`无法确定目标模型`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: '无法确定目标模型',
                type: 'internal_error',
                param: null,
                code: 'model_not_determined'
              }
            });
          }

          const model = modelDb.getById(targetModelId);
          if (!model) {
            memoryLogger.error(`模型不存在: ${targetModelId}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: '模型配置不存在',
                type: 'internal_error',
                param: null,
                code: 'model_not_found'
              }
            });
          }

          try {
            const smartRoutingResult = resolveSmartRouting(model);
            if (smartRoutingResult) {
              provider = smartRoutingResult.provider;
              providerId = smartRoutingResult.providerId;
              if (smartRoutingResult.modelOverride) {
                request.body = request.body || {};
                request.body.model = smartRoutingResult.modelOverride;
              }
            } else if (model.provider_id) {
              provider = providerDb.getById(model.provider_id);
              if (!provider) {
                memoryLogger.error(`提供商不存在: ${model.provider_id}`, 'Proxy');
                return reply.code(500).send({
                  error: {
                    message: '提供商配置不存在',
                    type: 'internal_error',
                    param: null,
                    code: 'provider_not_found'
                  }
                });
              }

              providerId = model.provider_id;
            }
          } catch (routingError: any) {
            memoryLogger.error(`智能路由失败: ${routingError.message}`, 'Proxy');
            return reply.code(500).send({
              error: {
                message: routingError.message || '智能路由失败',
                type: 'internal_error',
                param: null,
                code: 'smart_routing_error'
              }
            });
          }
        } catch (e) {
          memoryLogger.error(`解析 model_ids 失败: ${e}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: '虚拟密钥模型配置解析失败',
              type: 'internal_error',
              param: null,
              code: 'model_config_parse_error'
            }
          });
        }
      } else if (virtualKey.provider_id) {
        provider = providerDb.getById(virtualKey.provider_id);
        if (!provider) {
          memoryLogger.error(`提供商不存在: ${virtualKey.provider_id}`, 'Proxy');
          return reply.code(500).send({
            error: {
              message: '提供商配置不存在',
              type: 'internal_error',
              param: null,
              code: 'provider_not_found'
            }
          });
        }

        providerId = virtualKey.provider_id;
      } else {
        memoryLogger.error(`虚拟密钥未配置模型或提供商: ${virtualKeyValue}`, 'Proxy');
        return reply.code(500).send({
          error: {
            message: '虚拟密钥配置不完整',
            type: 'internal_error',
            param: null,
            code: 'invalid_key_config'
          }
        });
      }

      if (!provider) {
        memoryLogger.error(`提供商未找到`, 'Proxy');
        return reply.code(500).send({
          error: {
            message: '提供商配置未找到',
            type: 'internal_error',
            param: null,
            code: 'provider_not_found'
          }
        });
      }

      const decryptedApiKey = decryptApiKey(provider.api_key);
      const portkeyProviderType = getPortkeyProviderType(provider.base_url);

      const vkDisplay = virtualKeyValue && virtualKeyValue.length > 10
        ? `${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)}`
        : virtualKeyValue;

      const portkeyConfig: Record<string, any> = {
        provider: portkeyProviderType,
        api_key: decryptedApiKey,
      };

      if (provider.base_url) {
        const customHost = provider.base_url.replace(/\/+$/, '');
        portkeyConfig.custom_host = customHost;
      }

      if (virtualKey.cache_enabled === 1) {
        memoryLogger.debug(
          `网关缓存已启用 | 虚拟密钥: ${vkDisplay}`,
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
        memoryLogger.error('没有可用的 Portkey Gateway', 'Proxy');
        return reply.code(503).send({
          error: {
            message: '没有可用的 Portkey Gateway，请在系统设置中配置',
            type: 'service_unavailable',
            param: null,
            code: 'no_gateway_available'
          }
        });
      }

      const portkeyUrl = `${selectedGateway.url}${path}`;

      const isStreamRequest = request.body?.stream === true;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-portkey-config': JSON.stringify(portkeyConfig),
      };

      if (isStreamRequest) {
        headers['Accept'] = 'text/event-stream';
      }

      Object.keys(request.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.startsWith('x-') &&
            lowerKey !== 'x-portkey-virtual-key' &&
            lowerKey !== 'x-portkey-config') {
          headers[key] = request.headers[key] as string;
        }
      });

      const redactedConfig = { ...portkeyConfig };
      if (redactedConfig.api_key) {
        const k = redactedConfig.api_key;
        redactedConfig.api_key = k && k.length > 10 ? `${k.slice(0, 6)}...${k.slice(-4)}` : '***';
      }

      memoryLogger.info(
        `代理请求: ${request.method} ${path} | 虚拟密钥: ${vkDisplay} | 提供商: ${providerId}`,
        'Proxy'
      );
      memoryLogger.debug(
        `转发到 Portkey: ${portkeyUrl} | config: ${JSON.stringify(redactedConfig)}`,
        'Proxy'
      );

      let requestBody: string | undefined;

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestBody = JSON.stringify(request.body);
        const truncatedBody = requestBody.length > 500
          ? `${requestBody.substring(0, 500)}... (总长度: ${requestBody.length} 字符)`
          : requestBody;
        memoryLogger.debug(
          `请求体: ${truncatedBody}`,
          'Proxy'
        );
      }

      memoryLogger.debug(
        `转发请求: ${request.method} ${portkeyUrl} | 流式: ${isStreamRequest}`,
        'Proxy'
      );

      if (isStreamRequest) {
        memoryLogger.info(
          `流式请求开始: ${path} | 虚拟密钥: ${vkDisplay}`,
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
            `流式请求完成: 耗时 ${duration}ms | Tokens: ${tokenUsage.totalTokens}`,
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
          });

          return;
        } catch (streamError: any) {
          const duration = Date.now() - startTime;
          memoryLogger.error(
            `流式请求失败: ${streamError.message}`,
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

      if (virtualKey.cache_enabled === 1 && !isStreamRequest && request.body) {
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
          });

          memoryLogger.info(
            `请求完成: 200 | 耗时: ${duration}ms | Tokens: ${cached.response.usage?.total_tokens || 0} | 缓存命中`,
            'Proxy'
          );

          return reply.send(cached.response);
        }

        memoryLogger.debug(
          `缓存未命中 | key=${cacheKey.substring(0, 8)}... | 虚拟密钥: ${vkDisplay}`,
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
        ? `${responseText.substring(0, 500)}... (总长度: ${responseText.length} 字符)`
        : responseText;

      memoryLogger.debug(
        `原始响应体: ${truncatedResponseText}`,
        'Proxy'
      );

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const isJsonResponse = contentType.includes('application/json') || contentType.includes('json');

      if (!isJsonResponse && responseText) {
        memoryLogger.warn(
          `上游返回非 JSON 响应: Content-Type=${contentType}`,
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
          logMessage = `响应摘要: ${JSON.stringify(summary)}`;
        } else {
          logMessage = `完整响应: ${responseDataStr}`;
        }

        memoryLogger.debug(logMessage, 'Proxy');
      } catch (parseError) {
        memoryLogger.error(
          `JSON 解析失败: ${parseError} | 原始响应前 200 字符: ${responseText.substring(0, 200)}`,
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
      });

      if (isSuccess) {
        if (cacheKey && virtualKey.cache_enabled === 1 && !isStreamRequest && !fromCache) {
          const cacheHeaders: Record<string, string> = { ...responseHeaders };
          requestCache.set(cacheKey, responseData, cacheHeaders);
          reply.header('X-Cache-Status', 'MISS');

          memoryLogger.debug(
            `响应已缓存 | key=${cacheKey.substring(0, 8)}... | model=${request.body?.model}`,
            'Proxy'
          );
        }

        const cacheStatus = fromCache ? '缓存命中' : '缓存未命中';
        memoryLogger.info(
          `请求完成: ${response.statusCode} | 耗时: ${duration}ms | Tokens: ${usage.total_tokens || 0} | ${cacheStatus}`,
          'Proxy'
        );
      } else {
        const errorStr = JSON.stringify(responseData);
        const truncatedError = errorStr.length > 500
          ? `${errorStr.substring(0, 500)}... (总长度: ${errorStr.length} 字符)`
          : errorStr;
        memoryLogger.error(
          `请求失败: ${response.statusCode} | 耗时: ${duration}ms | 错误: ${truncatedError}`,
          'Proxy'
        );


      }

      reply.header('Content-Type', 'application/json');

      memoryLogger.debug(
        `发送给客户端的响应结构: ${JSON.stringify({
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
        `代理请求失败: ${error.message}`,
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

