import type { FastifyReply } from 'fastify';

import { normalizeUsageCounts } from './usage-normalizer.js';
import { BoundedChunkRecorder } from './bounded-chunk-recorder.js';
import { createInitialAggregate, processResponsesEvent, type ResponsesAggregate } from './responses-parser.js';
import { EmptyOutputError } from '../errors/empty-output-error.js';

// Responses API 空输出重试默认次数（可通过环境变量或模型属性配置）
export const DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES = Math.max(
  parseInt(process.env.RESPONSES_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

type SyncStreamRestorer = {
  process: (key: string, content: string) => string;
  flush: (key: string) => string;
};

type StreamLogger = {
  info: (msg: string, tag?: string) => void;
  warn: (msg: string, tag?: string) => void;
  error: (msg: string, tag?: string) => void;
};

export function serializeChunkToSse(chunk: any): string {
  const chunkData = JSON.stringify(chunk);
  const eventName = typeof chunk?.type === 'string' ? chunk.type : undefined;
  const eventPrefix = eventName ? `event: ${eventName}\n` : '';
  return `${eventPrefix}data: ${chunkData}\n\n`;
}

export function extractUsageFromChunk(chunk: any): ReturnType<typeof normalizeUsageCounts> | null {
  const usageInChunk: any =
    chunk?.usage ?? (chunk?.response && (chunk.response as any).usage) ?? null;
  if (!usageInChunk) return null;
  return normalizeUsageCounts(usageInChunk);
}

export function classifyStreamErrorEvent(chunk: any): { statusCode: number; message: string } | null {
  if (!chunk || (chunk as any)?.type !== 'response.error' && !(chunk as any)?.error) return null;
  const errorInfo = (chunk as any)?.error;
  const errorType: string = errorInfo?.type || 'api_error';
  const errorMessage: string = errorInfo?.message || 'Upstream returned a stream error';
  const statusCode =
    errorType === 'rate_limit_error' ? 429
    : errorType === 'authentication_error' ? 401
    : errorType === 'permission_error' ? 403
    : errorType === 'invalid_request_error' ? 400
    : 500;
  return { statusCode, message: errorMessage };
}

function responsesEventHasAssistantContent(event: any): boolean {
  if (!event || typeof event !== 'object') return false;

  if (typeof event.type === 'string' && event.type.startsWith('response.output_')) {
    return true;
  }
  if (Array.isArray(event.output) && event.output.length > 0) return true;

  const responseOutput = event.response?.output;
  if (Array.isArray(responseOutput) && responseOutput.length > 0) return true;

  if (event.delta && typeof event.delta === 'object' && Object.keys(event.delta).length > 0) return true;

  return false;
}

export interface OpenAIResponsesStreamProcessorOptions {
  client: any;
  requestParams: any;
  upstreamRequestStartedAt?: number;

  reply: FastifyReply;
  responseHeaders: Record<string, string>;
  baseUpstreamRequestOptions?: any;
  abortSignal?: AbortSignal;

  totalAttempts: number;
  initTimeoutMs: number;

  streamRestorer?: SyncStreamRestorer | null;

  logger?: StreamLogger;
}

/** Explicit per-attempt phases for the stream consumption state machine. */
type AttemptPhase = 'buffering' | 'streaming' | 'completed' | 'errored';

interface AttemptResult {
  success: boolean;
  emptyError: EmptyOutputError | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  streamChunks: string[];
  tffbMs?: number;
}

class SseWriter {
  private readonly recorded = new BoundedChunkRecorder();
  private readonly pending: string[] = [];
  private phase: AttemptPhase = 'buffering';

  constructor(
    private readonly reply: FastifyReply,
    private readonly responseHeaders: Record<string, string>
  ) {}

  private ensureHeadersSent(): void {
    if (!this.reply.raw.headersSent) {
      this.reply.raw.writeHead(200, this.responseHeaders);
    }
  }

  get recordedChunks(): string[] {
    return this.recorded.chunks;
  }

  get isBuffering(): boolean {
    return this.phase === 'buffering';
  }

  /** Write a frame directly to the client (handles backpressure). */
  async write(data: string): Promise<void> {
    this.recorded.record(data);
    this.ensureHeadersSent();
    if (!this.reply.raw.write(data)) {
      await new Promise<void>((resolve) => this.reply.raw.once('drain', resolve));
    }
  }

  /** Buffer a frame while in the buffering phase. */
  async enqueue(data: string): Promise<void> {
    if (this.phase === 'buffering') {
      this.pending.push(data);
    } else {
      await this.write(data);
    }
  }

  /** Transition buffering → streaming and flush all pending frames. */
  async flush(): Promise<void> {
    if (this.phase !== 'buffering') return;
    this.phase = 'streaming';
    while (this.pending.length > 0) {
      await this.write(this.pending.shift()!);
    }
  }

  /** Transition to terminal phase. */
  markCompleted(): void {
    this.phase = 'completed';
  }

  markErrored(): void {
    this.phase = 'errored';
  }
}

async function runStreamAttempt(
  attempt: number,
  totalAttempts: number,
  deps: {
    client: any;
    requestParams: any;
    reply: FastifyReply;
    responseHeaders: Record<string, string>;
    baseUpstreamRequestOptions?: any;
    abortSignal?: AbortSignal;
    initTimeoutMs: number;
    streamRestorer?: SyncStreamRestorer | null;
  },
  logger?: StreamLogger
): Promise<AttemptResult> {
  const {
    client,
    requestParams,
    reply,
    responseHeaders,
    baseUpstreamRequestOptions,
    abortSignal,
    initTimeoutMs,
    streamRestorer,
  } = deps;

  const writer = new SseWriter(reply, responseHeaders);

  // Per-attempt state
  const attemptStartedAt = Date.now();
  let attemptTffbMs: number | undefined;
  let hasAssistantOutput = false;
  let bypassEmptyGuard = false;
  let aggregate: ResponsesAggregate = createInitialAggregate();
  let bufferedOutputKeyUsed = false;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;

  const attemptAbortController = new AbortController();
  let initTimeoutId: ReturnType<typeof setTimeout> | undefined;
  if (initTimeoutMs > 0) {
    initTimeoutId = setTimeout(() => attemptAbortController.abort(), initTimeoutMs);
  }

  let abortHandler: (() => void) | undefined;
  if (abortSignal) {
    abortHandler = () => attemptAbortController.abort();
    if (abortSignal.aborted) {
      abortHandler();
    } else {
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const attemptUpstreamRequestOptions = baseUpstreamRequestOptions
    ? { ...baseUpstreamRequestOptions, signal: attemptAbortController.signal }
    : { signal: attemptAbortController.signal };

  let stream: AsyncIterable<any>;
  try {
    // SAFETY: OpenAI SDK returns Stream<ChatCompletionChunk>-like async iterable in streaming mode;
    // its generated union type doesn't narrow here, but every consumer iterates SSE chunk objects.
    stream = (await client.responses.create(
      requestParams,
      attemptUpstreamRequestOptions
    )) as unknown as AsyncIterable<any>;
  } finally {
    if (initTimeoutId) {
      clearTimeout(initTimeoutId);
    }
  }

  try {
    for await (const chunk of stream) {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        logger?.info('客户端已断开连接，停止流式传输', 'Protocol');
        break;
      }

      if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
        delete (chunk as any).instructions;
      }

      if (attemptTffbMs === undefined) {
        attemptTffbMs = Date.now() - attemptStartedAt;
      }

      const previousLength = aggregate.outputText.length;
      aggregate = processResponsesEvent(aggregate, chunk as any);
      const producedText = aggregate.outputText.length > previousLength;

      // Transition buffering → streaming on first assistant content
      if (!hasAssistantOutput && (producedText || responsesEventHasAssistantContent(chunk))) {
        hasAssistantOutput = true;
        await writer.flush();
      }

      // Error event: throw while still buffering (proper HTTP status),
      // otherwise flush and bypass the empty-output guard.
      const errorInfo = classifyStreamErrorEvent(chunk);
      if (errorInfo) {
        if (writer.isBuffering) {
          const err: any = new Error(errorInfo.message);
          err.status = errorInfo.statusCode;
          throw err;
        }
        bypassEmptyGuard = true;
        await writer.flush();
      }

      // Builtin PII protection: restore masked values in stream
      if (
        streamRestorer &&
        typeof (chunk as any)?.delta?.text === 'string' &&
        String((chunk as any)?.type || '').includes('output_text.delta')
      ) {
        bufferedOutputKeyUsed = true;
        (chunk as any).delta.text = streamRestorer.process('responses:output_text', (chunk as any).delta.text);
      }

      await writer.enqueue(serializeChunkToSse(chunk));

      // Usage extraction
      const norm = extractUsageFromChunk(chunk);
      if (norm) {
        if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) promptTokens = norm.promptTokens;
        if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) completionTokens = norm.completionTokens;
        if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) {
          totalTokens = norm.totalTokens;
        } else if (promptTokens > 0 || completionTokens > 0) {
          totalTokens = promptTokens + completionTokens;
        }
        if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) cachedTokens = norm.cachedTokens;
      }
    }

    // Flush any remaining content from builtin PII stream restorer
    if (streamRestorer && bufferedOutputKeyUsed && !reply.raw.destroyed && !reply.raw.writableEnded) {
      const flushText = streamRestorer.flush('responses:output_text');
      if (flushText) {
        const flushEvent: any = {
          type: 'response.output_text.delta',
          delta: { text: flushText },
        };
        await writer.enqueue(serializeChunkToSse(flushEvent));
      }
    }
  } finally {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler as any);
    }
  }

  writer.markCompleted();

  if (!hasAssistantOutput && !bypassEmptyGuard) {
    logger?.warn(
      `[Responses API] 未检测到 assistant 输出，准备重试 | attempt ${attempt}/${totalAttempts} | ` +
        `status=${aggregate.status} | last_event=${aggregate.lastEventType || 'unknown'}`,
      'Protocol'
    );

    return {
      success: false,
      emptyError: new EmptyOutputError('Responses API stream completed without assistant output', {
        source: 'responses',
        attempt,
        totalAttempts,
        status: aggregate.status,
        lastEventType: aggregate.lastEventType,
        responseId: aggregate.id,
      }),
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      streamChunks: writer.recordedChunks,
      tffbMs: attemptTffbMs,
    };
  }

  return {
    success: true,
    emptyError: null,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    streamChunks: writer.recordedChunks,
    tffbMs: attemptTffbMs,
  };
}

export async function processOpenAIResponsesStreamToSseWithRetry(
  options: OpenAIResponsesStreamProcessorOptions
): Promise<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  streamChunks: string[];
  tffbMs?: number;
}> {
  const {
    client,
    requestParams,
    reply,
    responseHeaders,
    baseUpstreamRequestOptions,
    abortSignal,
    totalAttempts,
    initTimeoutMs,
    streamRestorer,
    logger,
  } = options;

  let lastEmptyError: EmptyOutputError | null = null;
  let tffbMs: number | undefined;

  try {
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (abortSignal?.aborted) {
        const abortError = new Error('Request aborted');
        (abortError as any).name = 'AbortError';
        throw abortError;
      }

      const result = await runStreamAttempt(
        attempt,
        totalAttempts,
        { client, requestParams, reply, responseHeaders, baseUpstreamRequestOptions, abortSignal, initTimeoutMs, streamRestorer },
        logger
      );

      if (result.success) {
        tffbMs = result.tffbMs;

        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, responseHeaders);
          }
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        }

        return {
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          totalTokens: result.totalTokens,
          cachedTokens: result.cachedTokens,
          streamChunks: result.streamChunks,
          tffbMs,
        };
      }

      // Empty output — record error and retry
      lastEmptyError = result.emptyError;
    }
  } catch (error: any) {
    if (error.name === 'AbortError' || abortSignal?.aborted) {
      logger?.info('流式请求被用户取消', 'Protocol');
    }
    throw error;
  }

  // All attempts exhausted without assistant output
  const errorToThrow =
    lastEmptyError ||
    new EmptyOutputError('Responses API stream ended without assistant output', {
      source: 'responses',
      totalAttempts,
    });

  logger?.error(`[Responses API] 多次尝试仍为空返回，终止请求 | attempts=${totalAttempts}`, 'Protocol');
  throw errorToThrow;
}
