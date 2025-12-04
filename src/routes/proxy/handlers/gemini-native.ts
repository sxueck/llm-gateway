import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { normalizeUsageCounts } from '../../../utils/usage-normalizer.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { logApiRequestToDb } from '../../../services/api-request-logger.js';
import { shouldLogRequestBody } from './shared.js';
import { truncateRequestBody, truncateResponseBody } from '../../../utils/request-logger.js';
import type { ProtocolConfig } from '../../../services/protocol-adapter.js';
import type { VirtualKey } from '../../../types/index.js';

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
  let upstreamBase = (protocolConfig.baseUrl || '').replace(/\/+$/, '');
  const upstreamPath = path.startsWith('/') ? path : '/' + path;
  const fullUrl = upstreamBase + upstreamPath;

  // 添加 API Key 作为查询参数
  const url = new URL(fullUrl);
  url.searchParams.set('key', protocolConfig.apiKey);

  memoryLogger.debug(
    `上游 URL: ${url.toString().replace(protocolConfig.apiKey, '***')}`,
    'GeminiNative'
  );

  // 构造请求头
  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };

  // 转发部分请求头（排除敏感头）
  const excludedHeaders = ['authorization', 'host', 'connection', 'keep-alive'];
  Object.entries(request.headers).forEach(([key, value]) => {
    if (!excludedHeaders.includes(key.toLowerCase()) && value) {
      upstreamHeaders[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
  });

  // 准备请求体
  let requestBody: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    requestBody = JSON.stringify(request.body || {});
  }

  try {
    // 发起上游请求
    const upstreamResponse = await fetch(url.toString(), {
      method,
      headers: upstreamHeaders,
      body: requestBody,
    });

    // 获取响应体
    const responseText = await upstreamResponse.text();
    const duration = Date.now() - startTime;

    memoryLogger.debug(
      `上游响应: ${upstreamResponse.status} | ${duration}ms | body length: ${responseText.length}`,
      'GeminiNative'
    );

    // 转发响应头（排除某些头）
    const excludedResponseHeaders = ['content-length', 'transfer-encoding', 'connection'];
    upstreamResponse.headers.forEach((value, key) => {
      if (!excludedResponseHeaders.includes(key.toLowerCase())) {
        reply.header(key, value);
      }
    });

    // 设置状态码
    reply.code(upstreamResponse.status);

    // 解析响应体用于日志和统计
    let responseData: any;
    let tokenCount: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    
    try {
      responseData = JSON.parse(responseText);
      
      // 尝试从 usageMetadata 提取 token 统计
      if (responseData.usageMetadata) {
        const norm = {
          promptTokens: responseData.usageMetadata.promptTokenCount || 0,
          completionTokens: responseData.usageMetadata.candidatesTokenCount || 0,
          totalTokens: responseData.usageMetadata.totalTokenCount || 0,
          cachedTokens: responseData.usageMetadata.cachedContentTokenCount || 0,
        };
        
        tokenCount = await calculateTokensIfNeeded(
          norm.totalTokens,
          request.body,
          responseData,
          undefined,
          norm.promptTokens,
          norm.completionTokens
        );
      }
    } catch (e) {
      // 非 JSON 响应，直接透传
      memoryLogger.debug('响应非 JSON 格式，直接透传', 'GeminiNative');
    }

    // 记录日志
    const shouldLogBody = shouldLogRequestBody(virtualKey);
    const truncatedRequest = shouldLogBody && requestBody ? truncateRequestBody(JSON.parse(requestBody)) : undefined;
    const truncatedResponse = shouldLogBody && responseData ? truncateResponseBody(responseData) : undefined;

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
      truncatedResponse,
      cacheHit: 0,
    });

    memoryLogger.info(
      `Gemini 原生透传完成: ${upstreamResponse.status} | ${duration}ms | tokens: ${tokenCount.totalTokens}`,
      'GeminiNative'
    );

    // 直接发送响应文本
    return reply.send(responseText);
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    memoryLogger.error(
      `Gemini 原生透传失败: ${error.message}`,
      'GeminiNative',
      { error: error.stack }
    );

    // 记录错误日志
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
  
  memoryLogger.info(
    `Gemini 原生透传 (流式): ${method} ${path} | virtual key: ${vkDisplay}`,
    'GeminiNative'
  );

  // 构造上游 URL
  let upstreamBase = (protocolConfig.baseUrl || '').replace(/\/+$/, '');
  const upstreamPath = path.startsWith('/') ? path : '/' + path;
  const fullUrl = upstreamBase + upstreamPath;

  // 添加 API Key 作为查询参数
  const url = new URL(fullUrl);
  url.searchParams.set('key', protocolConfig.apiKey);

  memoryLogger.debug(
    `上游 URL (流式): ${url.toString().replace(protocolConfig.apiKey, '***')}`,
    'GeminiNative'
  );

  // 构造请求头
  const upstreamHeaders: Record<string, string> = {
    'accept': 'text/event-stream',
    'content-type': 'application/json',
  };

  // 转发部分请求头
  const excludedHeaders = ['authorization', 'host', 'connection', 'keep-alive'];
  Object.entries(request.headers).forEach(([key, value]) => {
    if (!excludedHeaders.includes(key.toLowerCase()) && value) {
      upstreamHeaders[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
  });

  // 准备请求体
  const requestBody = JSON.stringify(request.body || {});

  // 创建 AbortController 用于取消请求
  const abortController = new AbortController();

  // 监听客户端断开连接
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      memoryLogger.info('客户端断开连接，取消 Gemini 上游请求', 'GeminiNative');
    }
  });

  try {
    // 发起上游流式请求
    const upstreamResponse = await fetch(url.toString(), {
      method,
      headers: upstreamHeaders,
      body: requestBody,
      signal: abortController.signal,
    });

    // 设置下游响应头
    reply.raw.writeHead(upstreamResponse.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    // 如果上游非 2xx 响应
    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      const errorText = await upstreamResponse.text();
      memoryLogger.error(
        `Gemini 上游返回错误: ${upstreamResponse.status} | ${errorText.substring(0, 200)}`,
        'GeminiNative'
      );
      
      reply.raw.write(errorText);
      reply.raw.end();
      return;
    }

    // 检查 Content-Type
    const contentType = upstreamResponse.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      memoryLogger.warn(
        `上游非 SSE 响应: Content-Type=${contentType}`,
        'GeminiNative'
      );
      const text = await upstreamResponse.text();
      reply.raw.write(text);
      reply.raw.end();
      return;
    }

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

        // 检查下游连接状态
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          memoryLogger.info('下游连接已关闭，停止流式传输', 'GeminiNative');
          reader.cancel();
          break;
        }

        // 解码并写入下游
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
      `Gemini 原生流式透传完成: ${duration}ms | bytes: ${totalBytes}`,
      'GeminiNative'
    );

    // 尝试解析最后的 usage 信息
    let tokenCount: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
      // 从 SSE chunks 中提取 usage
      for (let i = streamChunks.length - 1; i >= 0; i--) {
        const chunk = streamChunks[i];
        const lines = chunk.split('\n');
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
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
        if (tokenCount.totalTokens > 0) break;
      }
    } catch (e) {
      // 忽略统计错误
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
    const duration = Date.now() - startTime;

    // 检查是否是用户取消
    if (error.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('Gemini 流式请求被客户端取消', 'GeminiNative');
      return;
    }

    memoryLogger.error(
      `Gemini 原生流式透传失败: ${error.message}`,
      'GeminiNative',
      { error: error.stack }
    );

    // 记录错误日志
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
    if (!reply.raw.headersSent && !reply.sent) {
      const errorPayload = {
        error: {
          message: error.message || 'Gemini native stream failed',
          type: 'api_error',
          param: null,
          code: 'gemini_native_stream_error'
        }
      };
      reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
      reply.raw.write(JSON.stringify(errorPayload));
      reply.raw.end();
    }
  }
}