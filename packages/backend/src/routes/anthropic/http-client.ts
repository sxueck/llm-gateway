import { FastifyReply } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { memoryLogger } from '../../services/logger.js';
import type { AnthropicRequest, AnthropicStreamEvent } from '../../types/anthropic.js';
import { normalizeAnthropicError } from '../../utils/http-error-normalizer.js';
import { EmptyOutputError } from '../../errors/empty-output-error.js';
import { filterForwardedHeaders, sanitizeCustomHeaders } from '../../utils/header-sanitizer.js';
import { PiiStreamRestorer } from '../../services/pii-protection-service.js';
import type { PiiProtectionContext } from '../../services/pii-protection-types.js';
import { removeV1Suffix } from '../../utils/api-endpoint-builder.js';
import { upstreamFetch } from '../../utils/upstream-fetch.js';
import { upstreamSslConfigService } from '../../services/upstream-ssl-config.js';
import { getProxyConfigFromEnv, getProxyUrlForTarget } from '../../utils/upstream-proxy.js';
import { normalizeAnthropicRequest } from '../../utils/anthropic-request-normalizer.js';
import { BoundedChunkRecorder } from '../../utils/bounded-chunk-recorder.js';

const DEFAULT_TIMEOUT_MS = 300_000;

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface StreamTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  streamChunks: string[];
}

function shouldUseUpstreamFetch(baseUrl: string | undefined): boolean {
  const skipVerify = upstreamSslConfigService.isSkipVerify();
  if (skipVerify) return true

  if (!baseUrl) return false

  const proxyConfig = getProxyConfigFromEnv();
  const proxyUrl = getProxyUrlForTarget(baseUrl, proxyConfig);
  return !!proxyUrl
}

function getAnthropicClient(baseUrl: string | undefined, apiKey: string, headers?: Record<string, string>): Anthropic {
  const clientConfig: any = {
    apiKey,
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS,
  };

  if (baseUrl) {
    clientConfig.baseURL = removeV1Suffix(baseUrl);
  }

  if (shouldUseUpstreamFetch(baseUrl)) {
    clientConfig.fetch = upstreamFetch;
  }

  // 添加自定义请求头支持
  const sanitizedHeaders = sanitizeCustomHeaders(headers);
  if (sanitizedHeaders && Object.keys(sanitizedHeaders).length > 0) {
    clientConfig.defaultHeaders = sanitizedHeaders;
    memoryLogger.debug(
      `添加自定义请求头 | headers: ${JSON.stringify(sanitizedHeaders)}`,
      'Anthropic'
    );
  }

  return new Anthropic(clientConfig);
}

function buildRequestParams(config: any, requestBody: AnthropicRequest, stream: boolean = false): any {
  const requestParams: any = {
    model: config.model,
    messages: requestBody.messages,
    max_tokens: requestBody.max_tokens,
  };

  // Some Anthropic-compatible providers implement /v1/messages by internally bridging to
  // OpenAI-style chat/tooling. When `thinking` is enabled, they may require
  // `reasoning_content` to exist on assistant tool-call messages.
  const thinking = requestBody.thinking;
  const thinkingEnabled = !!thinking && (thinking.type === 'enabled' || thinking.type === 'adaptive');
  if (thinkingEnabled) {
    try {
      if (Array.isArray(requestParams.messages)) {
        for (const msg of requestParams.messages) {
          if (!msg || typeof msg !== 'object') continue;
          if ((msg as any).role !== 'assistant') continue;
          if (!Array.isArray((msg as any).tool_calls) || (msg as any).tool_calls.length === 0) continue;
          const rc = (msg as any).reasoning_content;
          if (rc === undefined || rc === null || typeof rc !== 'string') (msg as any).reasoning_content = '';
        }
      }
    } catch {
      // Best-effort compatibility; ignore.
    }
  }

  if (stream) {
    requestParams.stream = true;
  }

  // 可选参数列表
  const optionalParams: Array<keyof AnthropicRequest> = [
    'system',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'service_tier',
    'speed',
    'inference_geo',
    'cache_control',
    'container',
    'context_management',
    'mcp_servers',
    'output_config',
    'metadata',
    'tool_choice',
    'thinking',
  ];

  // 批量处理可选参数
  for (const param of optionalParams) {
    if (requestBody[param] !== undefined) {
      requestParams[param] = requestBody[param];
    }
  }

  // 特殊处理 tools 参数
  if (requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
    requestParams.tools = requestBody.tools;
  }

  return requestParams;
}

function normalizeError(error: any): { statusCode: number; errorResponse: any } {
  const norm = normalizeAnthropicError(error);

  return {
    statusCode: norm.statusCode,
    errorResponse: {
      type: 'error',
      error: {
        type: norm.errorType,
        message: norm.message,
      },
    },
  };
}

const DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT = Math.max(
  parseInt(process.env.ANTHROPIC_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

function getAnthropicEmptyRetryLimit(config: any): number {
  const configured = config.modelAttributes?.anthropic_empty_retry_limit;
  if (typeof configured === 'number' && Number.isFinite(configured)) {
    return Math.max(0, Math.floor(configured));
  }
  return DEFAULT_ANTHROPIC_EMPTY_RETRY_LIMIT;
}

function hasAnthropicContent(event: AnthropicStreamEvent): boolean {
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return (event.delta.text || '').trim().length > 0;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
    return (event.delta.thinking || '').trim().length > 0;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'signature_delta') {
    return (event.delta.signature || '').trim().length > 0;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    return true;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use') {
    return true;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
    return true;
  }
  if (event.type === 'content_block_start' && event.content_block?.type === 'compaction') {
    return true;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    return true;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'compaction_delta') {
    return (event.delta.content || '').trim().length > 0;
  }
  return false;
}

function getAnthropicBetaHeaders(requestBody: AnthropicRequest): Record<string, string> | undefined {
  const betas = (requestBody as any)?.betas;
  if (!Array.isArray(betas) || betas.length === 0) return undefined;
  return { 'anthropic-beta': betas.join(',') };
}

function buildAnthropicRequestOptions(
  defaultHeaders: unknown,
  forwardedHeaders: Record<string, string> | undefined,
  requestBody: AnthropicRequest
): any {
  const betaHeaders = getAnthropicBetaHeaders(requestBody);
  const clientForwarded = filterForwardedHeaders(defaultHeaders, forwardedHeaders);

  if (!betaHeaders && !clientForwarded) {
    return undefined;
  }

  return {
    headers: {
      ...(clientForwarded || {}),
      ...(betaHeaders || {}),
    },
  } as any;
}

function hasAnthropicBetas(requestBody: AnthropicRequest): boolean {
  const betas = (requestBody as any)?.betas;
  return Array.isArray(betas) && betas.length > 0;
}

async function createAnthropicMessage(
  client: Anthropic,
  requestParams: any,
  requestBody: AnthropicRequest,
  requestOpts: any
): Promise<any> {
  if (!hasAnthropicBetas(requestBody)) {
    return client.messages.create(requestParams, requestOpts);
  }

  try {
    return await (client as any).beta?.messages?.create(
      { ...requestParams, betas: (requestBody as any).betas },
      requestOpts
    );
  } catch (error: any) {
    memoryLogger.debug(
      `Anthropic beta messages.create 调用失败，回退到标准 messages.create | error: ${error?.message || String(error)}`,
      'Anthropic'
    );
    return client.messages.create(requestParams, requestOpts);
  }
}

function createAnthropicMessageStream(
  client: Anthropic,
  requestParams: any,
  requestBody: AnthropicRequest,
  requestOpts: any
): any {
  if (!hasAnthropicBetas(requestBody)) {
    return client.messages.stream(requestParams, requestOpts);
  }

  try {
    return (client as any).beta?.messages?.stream(
      { ...requestParams, betas: (requestBody as any).betas },
      requestOpts
    );
  } catch (error: any) {
    memoryLogger.debug(
      `Anthropic beta messages.stream 调用失败，回退到标准 messages.stream | error: ${error?.message || String(error)}`,
      'Anthropic'
    );
    return client.messages.stream(requestParams, requestOpts);
  }
}

function ensureSseHeaders(reply: FastifyReply): void {
  if (!reply.raw.headersSent) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  }
}

interface StreamAttemptResult {
  promptTokens: number;
  completionTokens: number;
  hasAssistantContent: boolean;
  streamChunks: string[];
}

interface AnthropicPiiDeltaKey {
  blockIndex: number;
  deltaType: 'text_delta' | 'thinking_delta';
}

function buildAnthropicPiiDeltaKey(blockIndex: number, deltaType: 'text_delta' | 'thinking_delta'): string {
  return `anthropic:block:${blockIndex}:${deltaType === 'text_delta' ? 'text' : 'thinking'}`;
}

function buildAnthropicPiiFlushEvent(key: AnthropicPiiDeltaKey, text: string): AnthropicStreamEvent {
  return {
    type: 'content_block_delta',
    index: key.blockIndex,
    delta: key.deltaType === 'text_delta'
      ? { type: 'text_delta', text }
      : { type: 'thinking_delta', thinking: text },
  };
}

export async function consumeAnthropicStreamAttempt(
  stream: any,
  reply: FastifyReply,
  flushOnEmptyOutput: boolean,
  piiCtx?: PiiProtectionContext | null
): Promise<StreamAttemptResult> {
  let inputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;
  let buffering = true;
  const pendingChunks: string[] = [];
  let hasAssistantContent = false;
  const streamChunks = new BoundedChunkRecorder();

  // Initialize PII stream restorer if context is provided
  const piiRestorer = piiCtx ? new PiiStreamRestorer(piiCtx) : null;
  const usedPiiKeys = new Map<string, AnthropicPiiDeltaKey>();

  const flushPendingChunks = () => {
    if (!buffering) return;
    buffering = false;
    ensureSseHeaders(reply);
    for (const chunk of pendingChunks) {
      reply.raw.write(chunk);
      streamChunks.record(chunk);
    }
    pendingChunks.length = 0;
  };

  const writeChunk = (chunk: string) => {
    if (buffering) {
      pendingChunks.push(chunk);
      return;
    }

    ensureSseHeaders(reply);
    reply.raw.write(chunk);
    streamChunks.record(chunk);
  };

  const flushPiiKey = (key: string) => {
    if (!piiRestorer) return;
    const keyMeta = usedPiiKeys.get(key);
    if (!keyMeta) return;

    const flushedText = piiRestorer.flush(key);
    if (!flushedText) return;

    const flushEvent = buildAnthropicPiiFlushEvent(keyMeta, flushedText);
    writeChunk(`event: ${flushEvent.type}\ndata: ${JSON.stringify(flushEvent)}\n\n`);
  };

  const flushPiiKeysForBlock = (blockIndex: number | undefined) => {
    if (blockIndex === undefined) return;
    for (const [key, keyMeta] of usedPiiKeys) {
      if (keyMeta.blockIndex === blockIndex) {
        flushPiiKey(key);
      }
    }
  };

  const flushAllPiiKeys = () => {
    for (const key of usedPiiKeys.keys()) {
      flushPiiKey(key);
    }
  };

  for await (const event of stream) {
    const eventData = event as AnthropicStreamEvent;

    if (!hasAssistantContent && hasAnthropicContent(eventData)) {
      hasAssistantContent = true;
      flushPendingChunks();
    }

    if (eventData.type === 'message_start') {
      if (eventData.message?.usage) {
        inputTokens = eventData.message.usage.input_tokens || 0;
        const anyUsage: any = eventData.message.usage as any;
        cacheCreationInputTokens = anyUsage?.cache_creation_input_tokens || 0;
        cacheReadInputTokens = anyUsage?.cache_read_input_tokens || 0;
      }
    } else if (eventData.type === 'message_delta') {
      const anyUsage: any = (eventData as any).usage;
      if (anyUsage && anyUsage.output_tokens !== undefined) {
        outputTokens = anyUsage.output_tokens as number;
      }
    }

    if (piiRestorer) {
      const shouldFlushBlockKeys =
        eventData.type === 'content_block_stop' ||
        eventData.type === 'message_stop' ||
        (eventData.type === 'content_block_delta' &&
          eventData.delta?.type !== 'text_delta' &&
          eventData.delta?.type !== 'thinking_delta');

      if (shouldFlushBlockKeys && eventData.type === 'message_stop') {
        flushAllPiiKeys();
      } else if (shouldFlushBlockKeys) {
        flushPiiKeysForBlock(eventData.index);
      }
    }

    // PII protection: restore masked values in stream text deltas
    // Only restore text/thinking deltas, NOT input_json_delta or signature_delta
    if (piiRestorer && eventData.type === 'content_block_delta' && eventData.delta) {
      const blockIndex = eventData.index ?? 0;

      // Restore text_delta content
      if (eventData.delta.type === 'text_delta' && typeof eventData.delta.text === 'string') {
        const key = buildAnthropicPiiDeltaKey(blockIndex, 'text_delta');
        usedPiiKeys.set(key, { blockIndex, deltaType: 'text_delta' });
        eventData.delta.text = piiRestorer.process(key, eventData.delta.text);
      }

      // Restore thinking_delta content
      if (eventData.delta.type === 'thinking_delta' && typeof eventData.delta.thinking === 'string') {
        const key = buildAnthropicPiiDeltaKey(blockIndex, 'thinking_delta');
        usedPiiKeys.set(key, { blockIndex, deltaType: 'thinking_delta' });
        eventData.delta.thinking = piiRestorer.process(key, eventData.delta.thinking);
      }

      // Note: We explicitly do NOT restore input_json_delta or signature_delta
      // as these are structured payloads that should not be mutated
    }

    const sseData = `event: ${eventData.type}\ndata: ${JSON.stringify(eventData)}\n\n`;
    writeChunk(sseData);
  }

  // Flush any pending PII restoration buffers
  if (piiRestorer) {
    flushAllPiiKeys();
  }

  try {
    const finalMessage: any = await (stream as any).finalMessage?.();
    if (finalMessage?.usage) {
      inputTokens = finalMessage.usage.input_tokens ?? inputTokens;
      outputTokens = finalMessage.usage.output_tokens ?? outputTokens;
      cacheCreationInputTokens = finalMessage.usage.cache_creation_input_tokens ?? cacheCreationInputTokens;
      cacheReadInputTokens = finalMessage.usage.cache_read_input_tokens ?? cacheReadInputTokens;
    }
  } catch (error: any) {
    memoryLogger.debug(
      `Anthropic finalMessage usage 获取失败，保留流式事件统计值 | error: ${error?.message || String(error)}`,
      'Anthropic'
    );
  }

  if (hasAssistantContent || flushOnEmptyOutput) {
    flushPendingChunks();
  }

  if (hasAssistantContent && !reply.raw.writableEnded) {
    reply.raw.end();
  }

  const promptTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const completionTokens = outputTokens;

  return {
    promptTokens,
    completionTokens,
    hasAssistantContent,
    streamChunks: streamChunks.chunks,
  };
}

export async function makeAnthropicRequest(
  config: any,
  requestBody: AnthropicRequest,
  forwardedHeaders?: Record<string, string>
): Promise<HttpResponse> {
  try {
    const headers = config.modelAttributes?.headers;
    const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);
    const normalizedRequest = normalizeAnthropicRequest(config.model, requestBody);
    const requestParams = buildRequestParams(config, normalizedRequest);
    const requestOpts = buildAnthropicRequestOptions(config?.modelAttributes?.headers, forwardedHeaders, normalizedRequest);
    const response = await createAnthropicMessage(client, requestParams, normalizedRequest, requestOpts);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response)
    };
  } catch (error: any) {
    const { statusCode, errorResponse } = normalizeError(error);

    return {
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(errorResponse)
    };
  }
}

export async function makeAnthropicStreamRequest(
  config: any,
  requestBody: AnthropicRequest,
  reply: FastifyReply,
  forwardedHeaders?: Record<string, string>,
  piiCtx?: PiiProtectionContext | null
): Promise<StreamTokenUsage> {
  const headers = config.modelAttributes?.headers;
  const requestOpts = buildAnthropicRequestOptions(headers, forwardedHeaders, requestBody);

  const totalAttempts = Math.max(1, getAnthropicEmptyRetryLimit(config) + 1);
  let lastEmptyError: EmptyOutputError | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const client = getAnthropicClient(config.baseUrl, config.apiKey, headers);
    const normalizedRequest = normalizeAnthropicRequest(config.model, requestBody);
    const requestParams = buildRequestParams(config, normalizedRequest, true);

    try {
      const stream = createAnthropicMessageStream(client, requestParams, normalizedRequest, requestOpts);
      const attemptResult = await consumeAnthropicStreamAttempt(
        stream,
        reply,
        attempt === totalAttempts,
        piiCtx
      );

      if (!attemptResult.hasAssistantContent) {
        if (attempt < totalAttempts) {
          memoryLogger.warn(
            `Anthropic 流式无实际输出，准备重试 | attempt ${attempt}/${totalAttempts}`,
            'Anthropic'
          );
          lastEmptyError = new EmptyOutputError(
            'Anthropic stream completed without assistant output',
            { source: 'claude', attempt, totalAttempts }
          );
          continue;
        }

        throw lastEmptyError || new EmptyOutputError(
          'Anthropic stream ended without assistant output',
          { source: 'claude', totalAttempts }
        );
      }

      return {
        promptTokens: attemptResult.promptTokens,
        completionTokens: attemptResult.completionTokens,
        totalTokens: attemptResult.promptTokens + attemptResult.completionTokens,
        streamChunks: attemptResult.streamChunks,
      };

    } catch (error: any) {
      if (error instanceof EmptyOutputError) {
        if (!reply.raw.writableEnded) {
            reply.raw.end();
        }
        throw error;
      }

      memoryLogger.error(
        `Anthropic stream request failed: ${error.message}`,
        'Anthropic',
        { error: error.stack }
      );

      const { statusCode, errorResponse } = normalizeError(error);

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(statusCode, {
          'Content-Type': 'application/json',
        });
        const errorData = `data: ${JSON.stringify(errorResponse)}\n\n`;
        reply.raw.write(errorData);
        reply.raw.end();
      } else {
         if (!reply.raw.writableEnded) {
             const errorData = `event: error\ndata: ${JSON.stringify(errorResponse)}\n\n`;
             reply.raw.write(errorData);
             reply.raw.end();
         }
      }

      throw error;
    }
  }
  throw new Error('Anthropic stream retries exhausted');
}
