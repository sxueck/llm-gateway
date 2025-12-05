import { FastifyRequest, FastifyReply } from 'fastify';
import { memoryLogger } from '../../../services/logger.js';
import { calculateTokensIfNeeded } from '../token-calculator.js';
import { logApiRequestToDb } from '../../../services/api-request-logger.js';
import { shouldLogRequestBody } from './shared.js';
import { truncateRequestBody } from '../../../utils/request-logger.js';
import { GeminiEmptyOutputError } from '../../../errors/gemini-empty-output-error.js';
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

const DEFAULT_GEMINI_EMPTY_RETRY_LIMIT = Math.max(
  parseInt(process.env.GEMINI_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

function getGeminiEmptyRetryLimit(protocolConfig: ProtocolConfig): number {
  const configured = protocolConfig.modelAttributes?.gemini_empty_retry_limit;
  if (typeof configured === 'number' && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_GEMINI_EMPTY_RETRY_LIMIT;
}

function hasAssistantSignalInParts(parts: any[] | undefined | null): boolean {
  if (!Array.isArray(parts)) return false;

  return parts.some((part) => {
    if (part == null) return false;

    if (typeof part === 'string') {
      return part.trim().length > 0;
    }

    if (typeof part !== 'object') {
      return false;
    }

    if (typeof part.text === 'string' && part.text.trim().length > 0) {
      return true;
    }

    if (Array.isArray(part.parts) && hasAssistantSignalInParts(part.parts)) {
      return true;
    }

    // 检查其它字段（函数调用、inlineData 等）是否存在有效内容
    return Object.keys(part).some((key) => {
      if (key === 'text' || key === 'parts') return false;
      const value = (part as any)[key];
      if (value == null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (typeof value === 'number' || typeof value === 'boolean') return true;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return false;
    });
  });
}

function inspectGeminiContent(content: any): boolean {
  if (!content) return false;

  if (Array.isArray(content)) {
    return content.some((item) => inspectGeminiContent(item));
  }

  if (typeof content.text === 'string' && content.text.trim().length > 0) {
    return true;
  }

  if (hasAssistantSignalInParts(content.parts)) {
    return true;
  }

  if (Array.isArray(content.contents)) {
    return content.contents.some((item: any) => inspectGeminiContent(item));
  }

  return false;
}

function hasGeminiAssistantContent(payload: any): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (Array.isArray(payload.candidates)) {
    for (const candidate of payload.candidates) {
      if (inspectGeminiContent(candidate?.content)) {
        return true;
      }
      if (Array.isArray(candidate?.contents) && candidate.contents.some((item: any) => inspectGeminiContent(item))) {
        return true;
      }
    }
  }

  if (Array.isArray(payload.contents) && payload.contents.some((item: any) => inspectGeminiContent(item))) {
    return true;
  }

  if (payload.delta) {
    if (typeof payload.delta.text === 'string' && payload.delta.text.trim().length > 0) {
      return true;
    }
    if (hasAssistantSignalInParts(payload.delta.parts)) {
      return true;
    }
  }

  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return true;
  }

  return false;
}

function isGeminiErrorPayload(payload: any): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  // 只识别最明显的错误/拦截信号，避免过度推断
  if (payload.error) return true;
  if (payload.promptFeedback && payload.promptFeedback.blockReason) return true;

  return false;
}

function extractSseDataPayload(eventChunk: string): string | null {
  if (!eventChunk) return null;
  const lines = eventChunk.split('\n');
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine.startsWith('data:')) continue;
    dataLines.push(rawLine.replace(/^data:\s?/, ''));
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payload = dataLines.join('\n').trim();
  return payload.length > 0 ? payload : null;
}

interface GeminiStreamAttemptResult {
  streamChunks: string[];
  totalBytes: number;
  hasAssistantContent: boolean;
  bypassGuard: boolean;
}

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
  let attemptTimeout: NodeJS.Timeout | null = null;
  const clearAttemptTimeout = () => {
    if (attemptTimeout) {
      clearTimeout(attemptTimeout);
      attemptTimeout = null;
    }
  };

  // 监听客户端断开连接
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      abortController.abort();
      clearAttemptTimeout();
      memoryLogger.info('客户端断开连接，取消 Gemini 上游请求', 'GeminiNative');
    }
  });

  const totalAttempts = Math.max(1, getGeminiEmptyRetryLimit(protocolConfig) + 1);
  const shouldLogBody = shouldLogRequestBody(virtualKey);
  let finalStreamChunks: string[] = [];
  let totalBytes = 0;
  let headersSent = false;
  let success = false;
  let lastEmptyError: GeminiEmptyOutputError | null = null;

  try {
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (abortController.signal.aborted) {
        break;
      }

      clearAttemptTimeout();
      attemptTimeout = setTimeout(() => {
        if (!abortController.signal.aborted) {
          abortController.abort();
          memoryLogger.warn('上游请求超时 (5分钟)', 'GeminiNative');
        }
      }, 5 * 60 * 1000);

      const upstreamResponse = await fetch(url.toString(), {
        method,
        headers: upstreamHeaders,
        body: requestBody,
        signal: abortController.signal,
      });

      clearAttemptTimeout();

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

        if (!headersSent) {
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
        } else if (!reply.raw.writableEnded) {
          const payload = {
            error: {
              message: errorResponse.error?.message || errorResponse.error || errorResponse.message || 'Upstream error',
              type: 'upstream_error',
              param: null,
              code: `gemini_${upstreamResponse.status}`
            }
          };
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          reply.raw.end();
        }
        return;
      }

      const contentType = upstreamResponse.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
        const text = await upstreamResponse.text();
        const duration = Date.now() - startTime;
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

      if (!headersSent) {
        reply.raw.writeHead(upstreamResponse.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Transfer-Encoding': 'chunked',
          'X-Accel-Buffering': 'no',
        });
        headersSent = true;
      }

      const attemptResult = await streamGeminiAttempt(
        upstreamResponse,
        reply,
        abortController.signal
      );

      if (!attemptResult.hasAssistantContent && !attemptResult.bypassGuard) {
        lastEmptyError = new GeminiEmptyOutputError(
          'Gemini native stream completed without assistant output',
          { attempt, totalAttempts }
        );
        memoryLogger.warn(
          `Gemini 原生流式无实际输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
          'GeminiNative'
        );
        continue;
      }

      totalBytes = attemptResult.totalBytes;
      finalStreamChunks = attemptResult.streamChunks;
      success = true;
      break;
    }

    if (!success) {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
      throw lastEmptyError || new GeminiEmptyOutputError(
        'Gemini native stream ended without assistant output',
        { totalAttempts }
      );
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }

    const duration = Date.now() - startTime;

    memoryLogger.info(
      `Gemini 原生流式透传完成: ${duration}ms | bytes: ${totalBytes} | chunks: ${finalStreamChunks.length}`,
      'GeminiNative'
    );

    let tokenCount: any = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let i = finalStreamChunks.length - 1; i >= 0; i--) {
      const lines = finalStreamChunks[i].split('\n');
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
    clearAttemptTimeout();
    const duration = Date.now() - startTime;

    if (error.name === 'AbortError' || abortController.signal.aborted) {
      memoryLogger.info('Gemini 流式请求被取消（客户端断开或超时）', 'GeminiNative');
      return;
    }

    memoryLogger.error(
      `Gemini 原生流式透传失败: ${error.message}`,
      'GeminiNative'
    );

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

async function streamGeminiAttempt(
  upstreamResponse: Response,
  reply: FastifyReply,
  abortSignal: AbortSignal
): Promise<GeminiStreamAttemptResult> {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    throw new Error('无法读取上游响应流');
  }

  const decoder = new TextDecoder();
  const streamChunks: string[] = [];
  const pendingChunks: string[] = [];
  let buffering = true;
  let hasAssistantContent = false;
  let bypassGuard = false;
  let parserBuffer = '';
  let totalBytes = 0;

  const writeDirect = async (chunk: string) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }
    if (!reply.raw.write(chunk)) {
      await new Promise<void>((resolve) => {
        reply.raw.once('drain', resolve);
      });
    }
  };

  const flushPendingChunks = async () => {
    if (!buffering) return;
    buffering = false;
    while (pendingChunks.length > 0) {
      const pending = pendingChunks.shift();
      if (pending) {
        await writeDirect(pending);
      }
    }
  };

  const enqueueChunk = async (chunk: string) => {
    streamChunks.push(chunk);
    if (buffering) {
      pendingChunks.push(chunk);
    } else {
      await writeDirect(chunk);
    }
  };

  const processEvent = async (rawEvent: string) => {
    const payload = extractSseDataPayload(rawEvent);
    if (!payload || payload.length === 0) {
      return;
    }
    if (payload === '[DONE]') {
      if (hasAssistantContent || bypassGuard) {
        await flushPendingChunks();
      }
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    if (!hasAssistantContent && hasGeminiAssistantContent(parsed)) {
      hasAssistantContent = true;
      await flushPendingChunks();
    }

    if (!bypassGuard && isGeminiErrorPayload(parsed)) {
      bypassGuard = true;
      await flushPendingChunks();
    }
  };

  try {
    while (true) {
      if (abortSignal.aborted) {
        reader.cancel();
        break;
      }

      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      if (reply.raw.destroyed || reply.raw.writableEnded) {
        reader.cancel();
        break;
      }

      totalBytes += value.length;
      const chunk = decoder.decode(value, { stream: true });
      await enqueueChunk(chunk);

      parserBuffer += chunk.replace(/\r\n/g, '\n');
      let boundaryIndex = parserBuffer.indexOf('\n\n');
      while (boundaryIndex !== -1) {
        const eventChunk = parserBuffer.slice(0, boundaryIndex);
        parserBuffer = parserBuffer.slice(boundaryIndex + 2);
        await processEvent(eventChunk);
        boundaryIndex = parserBuffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (parserBuffer.trim().length > 0) {
    await processEvent(parserBuffer);
  }

  return {
    streamChunks,
    totalBytes,
    hasAssistantContent,
    bypassGuard,
  };
}
