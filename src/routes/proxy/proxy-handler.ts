import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { apiRequestDb } from '../../db/index.js';
import { memoryLogger } from '../../services/logger.js';
import { truncateRequestBody, truncateResponseBody, accumulateStreamResponse } from '../../utils/request-logger.js';
import { promptProcessor } from '../../services/prompt-processor.js';
import { makeHttpRequest, makeStreamHttpRequest } from './http-client.js';
import { checkCache, setCacheIfNeeded, getCacheStatus } from './cache.js';
import { authenticateVirtualKey } from './auth.js';
import { resolveModelAndProvider } from './model-resolver.js';
import { buildProviderConfig } from './provider-config-builder.js';

export function createProxyHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    let virtualKeyValue: string | undefined;
    let providerId: string | undefined;

    try {
      const authResult = authenticateVirtualKey(request.headers.authorization);
      if ('error' in authResult) {
        return reply.code(authResult.error.code).send(authResult.error.body);
      }

      const { virtualKey, virtualKeyValue: vkValue } = authResult;
      virtualKeyValue = vkValue;

      const modelResult = await resolveModelAndProvider(virtualKey, request, virtualKeyValue);
      if ('code' in modelResult) {
        return reply.code(modelResult.code).send(modelResult.body);
      }

      const { provider, providerId: resolvedProviderId, currentModel } = modelResult;
      providerId = resolvedProviderId;

      const configResult = buildProviderConfig(provider, virtualKey, virtualKeyValue, providerId, request);
      if ('code' in configResult) {
        return reply.code(configResult.code).send(configResult.body);
      }

      const { portkeyUrl, headers, path, vkDisplay, isStreamRequest } = configResult;

      if (currentModel && (request.body as any)?.messages && path.startsWith('/v1/chat/completions')) {
        const processorContext = {
          date: new Date().toISOString().split('T')[0],
          requestHeaders: request.headers,
        };

        if (currentModel.prompt_config) {
          const promptConfig = promptProcessor.parsePromptConfig(currentModel.prompt_config);

          if (promptConfig) {
            try {
              const processedMessages = promptProcessor.processMessages(
                (request.body as any).messages,
                promptConfig,
                processorContext
              );

              (request.body as any).messages = processedMessages;

              memoryLogger.info(
                `Prompt 处理完成 | 模型: ${currentModel.name} | 操作: ${promptConfig.operationType}`,
                'Proxy'
              );
            } catch (promptError: any) {
              memoryLogger.error(
                `Prompt 处理失败: ${promptError.message}`,
                'Proxy'
              );
            }
          }
        }
      }

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
        return await handleStreamRequest(
          request,
          reply,
          portkeyUrl,
          headers,
          requestBody,
          path,
          vkDisplay,
          virtualKey,
          providerId,
          startTime
        );
      }

      return await handleNonStreamRequest(
        request,
        reply,
        portkeyUrl,
        headers,
        requestBody,
        virtualKey,
        providerId,
        isStreamRequest,
        path,
        startTime
      );
    } catch (error: any) {
      const duration = Date.now() - startTime;

      memoryLogger.error(
        `Proxy request failed: ${error.message}`,
        'Proxy',
        { error: error.stack }
      );

      if (virtualKeyValue && providerId) {
        const { virtualKeyDb } = await import('../../db/index.js');
        const virtualKey = virtualKeyDb.getByKeyValue(virtualKeyValue);
        if (virtualKey) {
          const truncatedRequest = truncateRequestBody(request.body);

          apiRequestDb.create({
            id: nanoid(),
            virtual_key_id: virtualKey.id,
            provider_id: providerId,
            model: (request.body as any)?.model || 'unknown',
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
  };
}

async function handleStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  portkeyUrl: string,
  headers: Record<string, string>,
  requestBody: string | undefined,
  path: string,
  vkDisplay: string,
  virtualKey: any,
  providerId: string,
  startTime: number
) {
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
      model: (request.body as any)?.model || 'unknown',
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
      model: (request.body as any)?.model || 'unknown',
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

async function handleNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  portkeyUrl: string,
  headers: Record<string, string>,
  requestBody: string | undefined,
  virtualKey: any,
  providerId: string,
  isStreamRequest: boolean,
  path: string,
  startTime: number
) {
  let fromCache = false;
  const isEmbeddingsRequest = path.startsWith('/v1/embeddings');

  const vkDisplay = virtualKey.key_value && virtualKey.key_value.length > 10
    ? `${virtualKey.key_value.slice(0, 6)}...${virtualKey.key_value.slice(-4)}`
    : virtualKey.key_value;

  const cacheResult = checkCache(
    virtualKey,
    isStreamRequest,
    isEmbeddingsRequest,
    request.body,
    vkDisplay
  );

  if (cacheResult.cached) {
    fromCache = true;
    reply.headers({
      ...cacheResult.cached.headers,
      'X-Cache-Status': 'HIT'
    });
    reply.code(200);

    const duration = Date.now() - startTime;
    const truncatedRequest = truncateRequestBody(request.body);

    apiRequestDb.create({
      id: nanoid(),
      virtual_key_id: virtualKey.id,
      provider_id: providerId,
      model: (request.body as any)?.model || 'unknown',
      prompt_tokens: cacheResult.cached.response.usage?.prompt_tokens || 0,
      completion_tokens: cacheResult.cached.response.usage?.completion_tokens || 0,
      total_tokens: cacheResult.cached.response.usage?.total_tokens || 0,
      status: 'success',
      response_time: duration,
      error_message: undefined,
      request_body: truncatedRequest,
      response_body: truncateResponseBody(cacheResult.cached.response),
      cache_hit: 1,
      prompt_cache_hit_tokens: 0,
      prompt_cache_write_tokens: 0,
    });

    memoryLogger.info(
      `Request completed: 200 | ${duration}ms | tokens: ${cacheResult.cached.response.usage?.total_tokens || 0} | cache hit`,
      'Proxy'
    );

    return reply.send(cacheResult.cached.response);
  }

  const response = await makeHttpRequest(
    portkeyUrl,
    request.method,
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
    const truncatedResponse = responseText.length > 200
      ? `${responseText.substring(0, 200)}... (total length: ${responseText.length})`
      : responseText;
    memoryLogger.error(
      `JSON parse failed: ${parseError} | response: ${truncatedResponse}`,
      'Proxy'
    );
    responseData = {
      error: {
        message: 'Invalid JSON response from upstream',
        type: 'api_error',
        param: null,
        code: 'invalid_response'
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
    model: (request.body as any)?.model || 'unknown',
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
    setCacheIfNeeded(cacheResult.cacheKey, cacheResult.shouldCache, fromCache, responseData, responseHeaders);

    if (cacheResult.cacheKey && cacheResult.shouldCache && !fromCache) {
      reply.header('X-Cache-Status', 'MISS');
    }

    const cacheStatus = getCacheStatus(fromCache, cacheResult.shouldCache);
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
}

