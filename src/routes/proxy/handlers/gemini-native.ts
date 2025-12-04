import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { logApiRequestToDb } from '../../../services/api-request-logger.js';
import { shouldLogRequestBody } from './shared.js';
import { truncateRequestBody } from '../../../utils/request-logger.js';
import type { ProtocolConfig } from '../../../services/protocol-adapter.js';
import type { VirtualKey } from '../../../types/index.js';

// 需要排除的请求头（不转发到上游）
const EXCLUDED_REQUEST_HEADERS = [
  'authorization',
  'host',
  'connection',
  'keep-alive',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'content-length',
  'transfer-encoding',
];

/**
 * 构建上游请求头
 */
function buildUpstreamHeaders(
  requestHeaders: Record<string, string | string[] | undefined>,
  apiKey: string,
  isStream: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (isStream) {
    headers['accept'] = 'text/event-stream';
  }

  // 转发部分请求头
  Object.entries(requestHeaders).forEach(([key, value]) => {
    if (!EXCLUDED_REQUEST_HEADERS.includes(key.toLowerCase()) && value) {
      headers[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
  });

  // 添加 API Key 认证头
  headers['x-goog-api-key'] = apiKey;
  headers['x-api-key'] = apiKey;
  headers['api-key'] = apiKey;

  return headers;
}

/**
 * Gemini 原生协议透传 - 非流式请求
 */
export async function handleGeminiNativeNonStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: ProtocolConfig,
  path: string,
  virtualKey: VirtualKey,
  providerId: string,
  startTime: number,
  vkDisplay: string
): Promise<void> {
  const method = request.method;

  memoryLogger.info(
    `Gemini 原生透传 (非流式): ${method} ${path} | virtual key: ${vkDisplay}`,
    'GeminiNative'
  );

  // 构造上游 URL
  const baseForNative = protocolConfig.nativeBaseUrl || protocolConfig.baseUrl || '';
  const upstreamBase = baseForNative.replace(/\/+$/, '');
  if (!upstreamBase) {
    throw new Error('Gemini native baseUrl is not configured');
  }
  const upstreamPath = path.startsWith('/') ? path : '/' + path;
  const url = new URL(upstreamBase + upstreamPath);
  url.searchParams.set('key', protocolConfig.apiKey);

  // 构造请求头
  const upstreamHeaders = buildUpstreamHeaders(
    request.headers as Record<string, string | string[] | undefined>,
    protocolConfig.apiKey,
    false
  );

  // 准备请求体
  let requestBody: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    requestBody = JSON.stringify(request.body || {});
  }

  try {
    const upstreamResponse = await fetch(url.toString(), {
      method,
      headers: upstreamHeaders,
      body: requestBody,
    });

    const responseText = await upstreamResponse.text();
    const duration = Date.now() - startTime;

    // 转发响应头（排除某些头）
    const excludedResponseHeaders = ['content-length', 'transfer-encoding', 'connection'];
    upstreamResponse.headers.forEach((value, key) => {
      if (!excludedResponseHeaders.includes(key.toLowerCase())) {
        reply.header(key, value);
      }
    });

    reply.code(upstreamResponse.status);

    // 解析响应体用于日志和统计
    let responseData: any;
    let tokenCount: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      responseData = JSON.parse(responseText);

      if (responseData.usageMetadata) {
        tokenCount = await calculateTokensIfNeeded(
          responseData.usageMetadata.totalTokenCount || 0,
          request.body,
          responseData,
          undefined,
          responseData.usageMetadata.promptTokenCount || 0,
          responseData.usageMetadata.candidatesTokenCount || 0
        );
      }
    } catch {
      // 非 JSON 响应，直接透传
    }

    // 记录日志
    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody && requestBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;
    const isSuccess = upstreamResponse.status >= 200 && upstreamResponse.status < 300;

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: (request.body as any)?.model || 'unknown',
      tokenCount,
      status: isSuccess ? 'success' : 'error',
      responseTime: duration,
      errorMessage: isSuccess ? undefined : responseText.substring(0, 500),
      truncatedRequest,
      cacheHit: 0,
    });

    memoryLogger.info(
      `Gemini 原生透传完成: ${upstreamResponse.status} | ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'GeminiNative'
    );

    return reply.send(responseText);
  } catch (error: any) {
    const duration = Date.now() - startTime;

    memoryLogger.error(
      `Gemini 原生透传失败: ${error.message}`,
      'GeminiNative'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody && requestBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: (request.body as any)?.model || 'unknown',
      tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'error',
      responseTime: duration,
      errorMessage: error.message,
      truncatedRequest,
      cacheHit: 0,
    });

    if (!reply.sent) {
      return reply.code(500).send({
        error: {
          message: error.message || 'Gemini native proxy failed',
          type: 'api_error',
          param: null,
          code: 'gemini_native_error'
        }
      });
    }
  }
}

/**
 * Gemini 原生协议透传 - 流式请求
 */
export async function handleGeminiNativeStreamRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  protocolConfig: ProtocolConfig,
  path: string,
  virtualKey: VirtualKey,
  providerId: string,
  startTime: number,
  vkDisplay: string
): Promise<void> {
  const method = request.method;

  // 立即劫持 Fastify 的响应控制，直接操作原始 socket
  reply.hijack();

  memoryLogger.info(
    `Gemini 原生透传 (流式): ${method} ${path} | virtual key: ${vkDisplay}`,
    'GeminiNative'
  );

  // 构造上游 URL
  const baseForNative = protocolConfig.nativeBaseUrl || protocolConfig.baseUrl || '';
  const upstreamBase = baseForNative.replace(/\/+$/, '');
  if (!upstreamBase) {
    throw new Error('Gemini native baseUrl is not configured');
  }
  const upstreamPath = path.startsWith('/') ? path : '/' + path;
  const url = new URL(upstreamBase + upstreamPath);
  url.searchParams.set('key', protocolConfig.apiKey);
  url.searchParams.set('alt', 'sse');

  // 构造请求头
  const upstreamHeaders = buildUpstreamHeaders(
    request.headers as Record<string, string | string[] | undefined>,
    protocolConfig.apiKey,
    true
  );

  const requestBody = JSON.stringify(request.body || {});

  // 创建 AbortController 用于取消请求
  const abortController = new AbortController();
  const upstreamTimeoutId = setTimeout(() => {
    abortController.abort();
    memoryLogger.warn('上游请求超时 (5分钟)', 'GeminiNative');
  }, 5 * 60 * 1000);

  // 监听客户端断开连接
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      clearTimeout(upstreamTimeoutId);
      memoryLogger.info('客户端断开连接，取消 Gemini 上游请求', 'GeminiNative');
    }
  });

  try {
    const upstreamResponse = await fetch(url.toString(), {
      method,
      headers: upstreamHeaders,
      body: requestBody,
      signal: abortController.signal,
    });

    clearTimeout(upstreamTimeoutId);

    // 如果上游非 2xx 响应
    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      const errorText = await upstreamResponse.text();
      memoryLogger.error(
        `Gemini 上游返回错误: ${upstreamResponse.status} | ${errorText.substring(0, 200)}`,
        'GeminiNative'
      );

      let errorResponse;
      try {
        errorResponse = JSON.parse(errorText);
      } catch {
        errorResponse = { error: errorText };
      }

      const duration = Date.now() - startTime;
      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const truncatedRequest = shouldLogBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;

      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: (request.body as any)?.model || 'unknown',
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'error',
        responseTime: duration,
        errorMessage: `HTTP ${upstreamResponse.status}: ${errorText.substring(0, 500)}`,
        truncatedRequest,
        cacheHit: 0,
      });

      // 返回错误响应
      reply.raw.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
      reply.raw.write(JSON.stringify({
        error: {
          message: errorResponse.error?.message || errorResponse.error || errorResponse.message || 'Upstream error',
          type: 'upstream_error',
          param: null,
          code: `gemini_${upstreamResponse.status}`
        }
      }));
      reply.raw.end();
      return;
    }

    // 检查 Content-Type，如果不是 SSE 则直接返回
    const contentType = upstreamResponse.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
      const text = await upstreamResponse.text();
      const duration = Date.now() - startTime;
      const shouldLogBody = shouldLogRequestBody(virtualKey);
      const truncatedRequest = shouldLogBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;

      await logApiRequestToDb({
        virtualKey,
        providerId,
        model: (request.body as any)?.model || 'unknown',
        tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        status: 'success',
        responseTime: duration,
        truncatedRequest,
        cacheHit: 0,
      });

      reply.raw.writeHead(200, { 'Content-Type': contentType || 'application/json' });
      reply.raw.write(text);
      reply.raw.end();
      return;
    }

    // 设置 SSE 响应头
    reply.raw.writeHead(upstreamResponse.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
    });

    // 流式透传
    const reader = upstreamResponse.body?.getReader();
    if (!reader) {
      throw new Error('无法读取上游响应流');
    }

    const decoder = new TextDecoder();
    const streamChunks: string[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (reply.raw.destroyed || reply.raw.writableEnded) {
          reader.cancel();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        streamChunks.push(chunk);
        totalBytes += value.length;

        // 写入下游，处理背压
        if (!reply.raw.write(chunk)) {
          await new Promise<void>((resolve) => {
            reply.raw.once('drain', resolve);
          });
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 结束响应
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }

    const duration = Date.now() - startTime;

    memoryLogger.info(
      `Gemini 原生流式透传完成: ${duration}ms | bytes: ${totalBytes} | chunks: ${streamChunks.length}`,
      'GeminiNative'
    );

    // 从 SSE chunks 中提取 usage 信息
    let tokenCount: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let i = streamChunks.length - 1; i >= 0; i--) {
      const lines = streamChunks[i].split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.substring(6).trim();
          if (jsonStr && jsonStr !== '[DONE]') {
            try {
              const data = JSON.parse(jsonStr);
              if (data.usageMetadata) {
                tokenCount = {
                  promptTokens: data.usageMetadata.promptTokenCount || 0,
                  completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: data.usageMetadata.totalTokenCount || 0,
                };
                break;
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
      if (tokenCount.totalTokens > 0) break;
    }

    // 记录日志
    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: (request.body as any)?.model || 'unknown',
      tokenCount,
      status: 'success',
      responseTime: duration,
      truncatedRequest,
      cacheHit: 0,
    });

  } catch (error: any) {
    clearTimeout(upstreamTimeoutId);
    const duration = Date.now() - startTime;

    if (error.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('Gemini 流式请求被取消（客户端断开或超时）', 'GeminiNative');
      return;
    }

    memoryLogger.error(
      `Gemini 原生流式透传失败: ${error.message}`,
      'GeminiNative'
    );

    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;

    await logApiRequestToDb({
      virtualKey,
      providerId,
      model: (request.body as any)?.model || 'unknown',
      tokenCount: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'error',
      responseTime: duration,
      errorMessage: error.message,
      truncatedRequest,
      cacheHit: 0,
    });

    // 如果还没发送响应头，返回错误
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
      reply.raw.write(JSON.stringify({
        error: {
          message: error.message || 'Gemini native stream failed',
          type: 'api_error',
          param: null,
          code: 'gemini_native_stream_error'
        }
      }));
      reply.raw.end();
    }
  }
}
