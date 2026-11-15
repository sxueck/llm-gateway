import type { FastifyReply } from 'fastify';

import { extractReasoningFromChoice } from './request-logger.js';
import { normalizeUsageCounts } from './usage-normalizer.js';
import { BoundedChunkRecorder } from './bounded-chunk-recorder.js';
import { StreamTruncatedError, writeWithBackpressure } from './stream-guards.js';

import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';

// 续写会把已输出文本再送回上游。超过这个长度就不再续，避免一次必然失败的请求。
const STREAM_RESUME_MAX_CHARS = 64 * 1024;

// 仅重试续写请求的创建；已采纳的续写段再次失败时直接终止。
const STREAM_RESUME_MAX_REQUEST_ATTEMPTS = 3;
// 上游没有给出 Retry-After 头时的小退避。
const STREAM_RESUME_DEFAULT_BACKOFF_MS = 500;
// 对服务端建议等待时间的封顶（与 services/stream-resumer.ts 的上限互为镜像）。
const STREAM_RESUME_MAX_RETRY_AFTER_MS = 60_000;
// 续写间隙向下游发送 SSE 注释心跳的间隔；<=0 关闭心跳。
const STREAM_RESUME_HEARTBEAT_INTERVAL_MS = 5_000;
// SSE 规范要求客户端忽略以 ':' 开头的行，因此心跳不会干扰任何解析器。
const STREAM_RESUME_HEARTBEAT_FRAME = ': ping\n\n';

type SyncStreamRestorer = {
  process: (key: string, content: string) => string;
  flush: (key: string) => string;
};

/** Structured outcome of one continuation-request attempt: a stream on
 * success, otherwise whether the failure may be retried and the
 * server-advised wait (Retry-After) when the upstream provided one.
 * Returning this object (or a stream) tells the processor a continuation
 * request was actually created upstream — that is what increments
 * streamResumeAttempts; plain null means no request was created (e.g. the
 * system setting is off) and is never counted. */
export interface ResumeStreamOutcome {
  stream: AsyncIterable<any> | null;
  retryable?: boolean;
  /** Milliseconds advised by the upstream (Retry-After / retry-after-ms). */
  retryAfterMs?: number;
}

export interface StreamResumeRetryOptions {
  /** Total continuation-request attempts (first try + retries). Default 3. */
  maxAttempts?: number;
  /** Wait before retrying when no Retry-After header is available. Default 500ms. */
  defaultBackoffMs?: number;
  /** Upper bound applied to a server-advised Retry-After wait. Default 60s. */
  maxRetryAfterMs?: number;
  /** SSE comment heartbeat interval across the resume gap. Default 5s; <=0 disables. */
  heartbeatIntervalMs?: number;
}

function resolveResumeRetryNumber(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

export interface OpenAIChatStreamProcessorOptions {
  reply: FastifyReply;
  stream: AsyncIterable<any>;
  model: string;
  /** Report this model name to the client instead of the upstream identifier;
   * absent = byte-identical passthrough. */
  clientModel?: string;
  /** Debug comment line written right after the SSE headers (opt-in). */
  sseComment?: string;
  abortSignal?: AbortSignal;
  upstreamRequestStartedAt?: number;

  // Optional stream restorer for builtin PII protection
  streamRestorer?: SyncStreamRestorer | null;

  logger?: {
    info: (msg: string, tag?: string) => void;
    warn?: (msg: string, tag?: string) => void;
  };

  // Builds a continuation from delivered plain text; see ResumeStreamOutcome.
  resumeStreamFactory?: (
    partialText: string
  ) => Promise<AsyncIterable<any> | ResumeStreamOutcome | null>;

  /** Tuning for retrying the continuation request itself (e.g. upstream 429
   * with Retry-After). The factory reports retryability via
   * ResumeStreamOutcome; defaults live above as STREAM_RESUME_* constants. */
  resumeRetry?: StreamResumeRetryOptions;

  // When true, usage-only chunks (usage present, no meaningful choices) are
  // suppressed from the downstream SSE stream. Usage is still extracted for
  // gateway-internal accounting. Used when the downstream client did not
  // request stream_options.include_usage.
  skipUsageChunks?: boolean;
}

function isUsageOnlyChunk(chunk: any): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  if (!chunk.usage) return false;
  const choices = chunk.choices;
  return !Array.isArray(choices) || choices.length === 0;
}

export async function processOpenAIChatCompletionStreamToSse(
  options: OpenAIChatStreamProcessorOptions
): Promise<StreamTokenUsage> {
  const {
    reply,
    stream,
    model,
    clientModel,
    sseComment,
    abortSignal,
    upstreamRequestStartedAt,
    streamRestorer,
    logger,
    skipUsageChunks,
    resumeStreamFactory,
    resumeRetry: resumeRetryOptions,
  } = options;

  const resumeRetry = {
    maxAttempts: resolveResumeRetryNumber(
      resumeRetryOptions?.maxAttempts,
      STREAM_RESUME_MAX_REQUEST_ATTEMPTS,
      1
    ),
    defaultBackoffMs: resolveResumeRetryNumber(
      resumeRetryOptions?.defaultBackoffMs,
      STREAM_RESUME_DEFAULT_BACKOFF_MS,
      0
    ),
    maxRetryAfterMs: resolveResumeRetryNumber(
      resumeRetryOptions?.maxRetryAfterMs,
      STREAM_RESUME_MAX_RETRY_AFTER_MS,
      0
    ),
    heartbeatIntervalMs: resolveResumeRetryNumber(
      resumeRetryOptions?.heartbeatIntervalMs,
      STREAM_RESUME_HEARTBEAT_INTERVAL_MS,
      0
    ),
  };

  const bufferedKeys = new Set<string>();
  const finishedByChoiceIndex = new Set<number>();
  let lastChunkId: string | undefined;
  let lastChunkModel: string | undefined;

  // Headers are committed on the first write so an upstream that fails or ends
  // empty before producing output can still fall back to another target.
  const ensureHeaders = () => {
    if (reply.raw.headersSent) return;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    // Opt-in debug comment before the first event; SSE parsers must ignore
    // lines starting with ':' per spec (pi's parser skips them too).
    if (sseComment) {
      reply.raw.write(`: ${sseComment}\n\n`);
    }
  };

  let upstreamChunkCount = 0;
  let sawTerminal = false;
  let clientGone = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let tffbMs: number | undefined;
  const chunkRecorder = new BoundedChunkRecorder();
  let reasoningContent = '';
  let thinkingBlocks: ThinkingBlock[] = [];
  let toolCalls: any[] = [];

  // Stream-resume state: the first attempt's text already delivered
  // downstream, and the continuation segment stitching onto it.
  let activeStream: AsyncIterable<any> = stream;
  // resumeSegment：是否已采纳一段续写（终局门闩 —— 采纳过就绝不再续）。
  let resumeSegment = false;
  // resumeAttempts：已真实创建并发往上游的续写请求次数（含被 429/5xx 拒绝
  // 后的重试；初始请求不计）。仅工厂返回流或 ResumeStreamOutcome 时递增
  // （outcome = 请求已创建但被拒；返回 null 表示从未创建，如开关关闭）。
  let resumeAttempts = 0;
  let resumeChars = 0;
  let resumeBaseId: string | undefined;
  let skipNextRoleOnlyChunk = false;
  let partialContent = '';
  let sawNonTextDelta = false;
  let sawNonZeroChoiceIndex = false;

  // TFFB (Time to First Byte) is triggered by the first upstream stream event observed by gateway.
  // This measures gateway-level first event timing, not raw TCP bytes or first content/tool_call.

  const emitRestorerTail = async () => {
    if (!streamRestorer || bufferedKeys.size === 0 || reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }
    for (const key of bufferedKeys) {
      const flushText = streamRestorer.flush(key);
      if (!flushText) continue;

      const match = key.match(/^chat:(\d+):content$/);
      const choiceIndex = match ? Number(match[1]) : 0;
      if (finishedByChoiceIndex.has(choiceIndex)) continue;

      const flushChunk: any = {
        id: lastChunkId || `pii_flush_${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: lastChunkModel || model,
        choices: [
          {
            index: choiceIndex,
            delta: { content: flushText },
            finish_reason: null,
          },
        ],
      };
      const flushData = `data: ${JSON.stringify(flushChunk)}\n\n`;
      chunkRecorder.record(flushData);
      ensureHeaders();
      await writeWithBackpressure(reply.raw, flushData, abortSignal);
    }
  };

  // --- 续写间隙（resume gap）工具 ------------------------------------------
  // 间隙 = 上游流死亡 → 续写流首块到达。期间向下游发 SSE 注释心跳（': ping'）
  // 防止中间代理/客户端因空闲超时断开；同时随时感知客户端 abort。
  const resumeClientGone = (): boolean =>
    abortSignal?.aborted === true || reply.raw.destroyed || reply.raw.writableEnded;

  // 返回 false 表示客户端已不在（心跳写不出去或已 abort）。
  const writeResumeHeartbeat = async (): Promise<boolean> => {
    if (resumeClientGone()) return false;
    ensureHeaders();
    // 心跳不进 chunkRecorder：它是传输层保活，不是模型输出，
    // 也不应混入 token 计数/重放用的 chunk 序列。
    await writeWithBackpressure(reply.raw, STREAM_RESUME_HEARTBEAT_FRAME, abortSignal);
    return !resumeClientGone();
  };

  const sleepResumeGap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (ms <= 0 || abortSignal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });

  /** Waits `delayMs` keeping the SSE connection warm with comment heartbeats.
   * Returns false when the wait elapsed, true when the client disappeared. */
  const waitResumeGap = async (delayMs: number): Promise<boolean> => {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, delayMs);
    const interval = resumeRetry.heartbeatIntervalMs;
    let nextBeatAt = interval > 0 ? startedAt + interval : Number.POSITIVE_INFINITY;
    while (true) {
      if (resumeClientGone()) return true;
      const now = Date.now();
      if (now >= deadline) return false;
      if (now >= nextBeatAt) {
        if (!(await writeResumeHeartbeat())) return true;
        nextBeatAt += interval;
        continue;
      }
      await sleepResumeGap(Math.min(deadline, nextBeatAt) - now);
    }
  };

  /** Awaits the continuation factory while ticking heartbeats over the gap
   * (the factory covers the enabled-check DB read plus create() up to the
   * first response headers). Returns { clientGone: true } when the downstream
   * client disappears first; the pending factory promise stays error-guarded. */
  const awaitResumeFactory = async (): Promise<{
    clientGone: boolean;
    value?: any;
  }> => {
    const pending = Promise.resolve(resumeStreamFactory!(partialContent));
    // The race below owns rejections while it is pending; if the heartbeat
    // side wins first, a later rejection must not surface as unhandled.
    void pending.catch(() => {});

    if (resumeRetry.heartbeatIntervalMs <= 0) {
      const value = await pending;
      return { clientGone: resumeClientGone(), value };
    }

    const CLIENT_GONE = Symbol('resume-client-gone');
    let beatTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      const beating = new Promise<typeof CLIENT_GONE>((resolveBeat, rejectBeat) => {
        const tick = () => {
          if (stopped) return;
          if (resumeClientGone()) {
            resolveBeat(CLIENT_GONE);
            return;
          }
          void (async () => {
            if (!(await writeResumeHeartbeat())) {
              resolveBeat(CLIENT_GONE);
              return;
            }
            if (!stopped) beatTimer = setTimeout(tick, resumeRetry.heartbeatIntervalMs);
          })().catch(rejectBeat);
        };
        beatTimer = setTimeout(tick, resumeRetry.heartbeatIntervalMs);
      });

      const winner = await Promise.race([pending, beating]);
      if (winner === CLIENT_GONE) return { clientGone: true };
      return { clientGone: false, value: winner };
    } finally {
      stopped = true;
      clearTimeout(beatTimer);
    }
  };

  /** Runs the continuation-request attempts: honor the factory-reported
   * Retry-After wait when available, otherwise a small backoff; heartbeats
   * span the whole gap; abort/client-gone stops immediately. Returns the
   * adopted continuation stream, or null to keep the original failure
   * terminal. At most one continuation segment is ever adopted. Each factory
   * result that is a stream or a ResumeStreamOutcome counts as one upstream
   * continuation-request creation (resumeAttempts), including rejected
   * (e.g. 429) creations that are later retried. */
  const runResumeAttempts = async (): Promise<AsyncIterable<any> | null> => {
    // 先把还原器扣下的尾巴交给客户端，再清空它，避免接到续写开头。
    await emitRestorerTail();
    if (resumeClientGone()) return null;

    let advisedWaitMs: number | undefined;
    for (let attempt = 1; attempt <= resumeRetry.maxAttempts; attempt++) {
      if (attempt > 1) {
        // Do not retry earlier than the server requested. A delay beyond our
        // bounded resume window is terminal instead of being silently clamped.
        if (advisedWaitMs !== undefined && advisedWaitMs > resumeRetry.maxRetryAfterMs) {
          logger?.warn?.('断点续传: Retry-After 超出等待上限，停止重试', 'Protocol');
          return null;
        }
        const waitMs = advisedWaitMs ?? resumeRetry.defaultBackoffMs;
        logger?.info(
          `断点续传: 续写请求创建失败，${waitMs}ms 后进行第 ${attempt}/${resumeRetry.maxAttempts} 次尝试` +
            (advisedWaitMs !== undefined ? '（遵循上游 Retry-After）' : ''),
          'Protocol'
        );
        if (await waitResumeGap(waitMs)) return null;
      }

      let factoryValue: any;
      try {
        const outcome = await awaitResumeFactory();
        if (outcome.clientGone) return null;
        factoryValue = outcome.value;
      } catch {
        // 工厂契约是“从不抛出”（protocol-adapter 已把上游错误映射为
        // ResumeStreamOutcome）；意外抛出保持终态，不掩盖原始错误。
        return null;
      }

      let nextStream: AsyncIterable<any> | null = null;
      let retryable = false;
      let retryAfterMs: number | undefined;
      let createdRequest = false;
      if (
        factoryValue &&
        typeof factoryValue === 'object' &&
        'stream' in factoryValue
      ) {
        nextStream = factoryValue.stream ?? null;
        retryable = factoryValue.retryable === true;
        const advised = factoryValue.retryAfterMs;
        retryAfterMs =
          typeof advised === 'number' && Number.isFinite(advised) && advised >= 0
            ? advised
            : undefined;
        // ResumeStreamOutcome = 续写请求已真实创建但被上游拒绝（429/5xx 等）。
        createdRequest = true;
      } else {
        nextStream = (factoryValue ?? null) as AsyncIterable<any> | null;
        // 返回流 = 续写请求已创建且成功。返回 null = 未创建（开关关闭等）。
        createdRequest = nextStream !== null;
      }
      if (createdRequest) resumeAttempts += 1;

      if (nextStream) {
        logger?.warn?.(
          `断点续传: 上游流中断(已输出 ${partialContent.length} 字符)，续写请求成功(第 ${attempt} 次尝试)`,
          'Protocol'
        );
        return nextStream;
      }

      if (!retryable || attempt >= resumeRetry.maxAttempts) return null;
      advisedWaitMs = retryAfterMs;
    }
    return null;
  };
  streamLoop: while (true) {
    try {
      for await (const chunk of activeStream) {
        // Stop work if the downstream connection is gone.
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          logger?.info('客户端已断开连接，停止流式传输', 'Protocol');
          clientGone = true;
          break;
        }

        upstreamChunkCount += 1;
        if (
          (chunk as any)?.usage ||
          (Array.isArray((chunk as any)?.choices) &&
            (chunk as any).choices.some((choice: any) => choice?.finish_reason))
        ) {
          sawTerminal = true;
        }

        if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
          delete (chunk as any).instructions;
        }

        // 续写提示用上游原文。还原结果只写给客户端，不能再送回上游。
        let rawDeltaContent = '';
        if (!resumeSegment && Array.isArray((chunk as any).choices)) {
          for (const choice of (chunk as any).choices) {
            const content = choice?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              rawDeltaContent += content;
            }
          }
        }

        // Builtin PII protection: restore masked values in stream
        if (Array.isArray((chunk as any).choices) && streamRestorer) {
          for (const choice of (chunk as any).choices) {
            const idx = typeof choice?.index === 'number' ? choice.index : 0;
            const key = `chat:${idx}:content`;
            const content = choice?.delta?.content;

            if (typeof content === 'string') {
              bufferedKeys.add(key);
              choice.delta.content = streamRestorer.process(key, content);
            }

            // If upstream signals completion, flush any pending placeholder fragments into THIS chunk.
            if (choice?.finish_reason) {
              bufferedKeys.add(key);
              const flushText = streamRestorer.flush(key);
              if (flushText) {
                if (!choice.delta || typeof choice.delta !== 'object') {
                  choice.delta = { content: flushText };
                } else if (typeof choice.delta.content === 'string') {
                  choice.delta.content += flushText;
                } else {
                  choice.delta.content = flushText;
                }
              }
              finishedByChoiceIndex.add(idx);
            }
          }
        }

        // Stream-resume bookkeeping on what has already been delivered.
        if (Array.isArray((chunk as any).choices)) {
          for (const choice of (chunk as any).choices) {
            if (choice?.finish_reason) {
              const idx = typeof choice?.index === 'number' ? choice.index : 0;
              finishedByChoiceIndex.add(idx);
            }
            const delta: any = choice?.delta;
            if (!delta || typeof delta !== 'object') continue;
            if (
              Object.keys(delta).some(
                (key) =>
                  key !== 'role' &&
                  key !== 'content' &&
                  delta[key] !== undefined
              )
            ) {
              sawNonTextDelta = true;
            }
            if (typeof choice?.index === 'number' && choice.index > 0) {
              sawNonZeroChoiceIndex = true;
            }
          }
        }

        if (resumeSegment) {
          // Remove the continuation's leading role so downstream accumulators
          // append role-and-content chunks instead of starting a new message.
          if (skipNextRoleOnlyChunk) {
            const delta: any = (chunk as any).choices?.[0]?.delta;
            if (delta && typeof delta === 'object' && delta.role !== undefined) {
              const isRoleOnlyChunk = Object.keys(delta).every(
                (key) => key === 'role' || (key === 'content' && !delta.content)
              );
              delta.role = undefined;
              skipNextRoleOnlyChunk = false;
              if (isRoleOnlyChunk) {
                continue;
              }
            } else if (Array.isArray((chunk as any).choices) && (chunk as any).choices.length > 0) {
              skipNextRoleOnlyChunk = false;
            }
          }
          if (resumeBaseId && (chunk as any).id) {
            (chunk as any).id = resumeBaseId;
          }
        }

        if ((chunk as any)?.id) lastChunkId = String((chunk as any).id);
        if ((chunk as any)?.model) lastChunkModel = String((chunk as any).model);
        if (clientModel && (chunk as any)?.model) {
          (chunk as any).model = clientModel;
        }

        // Record TFFB on first upstream stream event observed
        if (tffbMs === undefined && upstreamRequestStartedAt) {
          tffbMs = Date.now() - upstreamRequestStartedAt;
        }

        // Suppress usage-only chunks when the downstream client did not request
        // include_usage. Usage extraction for billing still runs unconditionally below.
        if (!(skipUsageChunks && isUsageOnlyChunk(chunk))) {
          const chunkData = JSON.stringify(chunk);
          const sseData = `data: ${chunkData}\n\n`;
          chunkRecorder.record(sseData);

          ensureHeaders();
          await writeWithBackpressure(reply.raw, sseData, abortSignal);
          if (rawDeltaContent) {
            partialContent += rawDeltaContent;
          }
        }

        if ((chunk as any).usage) {
          const norm = normalizeUsageCounts((chunk as any).usage);
          if (!resumeSegment) {
            if (typeof norm.promptTokens === 'number' && norm.promptTokens > 0) {
              promptTokens = norm.promptTokens;
            }
            if (typeof norm.completionTokens === 'number' && norm.completionTokens > 0) {
              completionTokens = norm.completionTokens;
            }
            if (typeof norm.totalTokens === 'number' && norm.totalTokens > 0) {
              totalTokens = norm.totalTokens;
            } else if (promptTokens > 0 || completionTokens > 0) {
              totalTokens = promptTokens + completionTokens;
            }
            if (typeof norm.cachedTokens === 'number' && norm.cachedTokens > 0) {
              cachedTokens = norm.cachedTokens;
            }
          }
        }

        if ((chunk as any).choices && (chunk as any).choices[0]) {
          const extraction = extractReasoningFromChoice(
            (chunk as any).choices[0],
            reasoningContent,
            thinkingBlocks,
            toolCalls
          );
          reasoningContent = extraction.reasoningContent;
          thinkingBlocks = extraction.thinkingBlocks as ThinkingBlock[];
          toolCalls = extraction.toolCalls || [];
        }
      }

      // The SDK can end iteration silently after the client aborts.
      // Propagate cancellation so the route does not audit it as success.
      if (abortSignal?.aborted) throw new DOMException('Client aborted', 'AbortError');

      // The SDK ends the iterator silently on a graceful close without [DONE].
      if (!clientGone && !abortSignal?.aborted) {
        if (upstreamChunkCount === 0) {
          throw new StreamTruncatedError('Upstream stream ended without any data');
        }
        if (!sawTerminal) {
          throw new StreamTruncatedError();
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        logger?.info('流式请求被用户取消', 'Protocol');
        throw error;
      }

      // Stream resume: the upstream died mid-flight after plain-text deltas
      // were already flushed. Ask the factory for a continuation stream;
      // creation failures may be retried (Retry-After aware), but once a
      // segment was adopted (resumeSegment) a second mid-flight failure stays
      // terminal — at most one continuation segment is ever adopted.
      if (
        resumeStreamFactory &&
        !resumeSegment &&
        partialContent.length > 0 &&
        partialContent.length <= STREAM_RESUME_MAX_CHARS &&
        !sawNonTextDelta &&
        !sawNonZeroChoiceIndex &&
        !sawTerminal &&
        !reply.raw.destroyed &&
        !reply.raw.writableEnded
      ) {
        let nextStream: AsyncIterable<any> | null = null;
        try {
          nextStream = await runResumeAttempts();
        } catch (resumeError) {
          if (resumeError === error) throw resumeError;
          nextStream = null;
        }
        if (nextStream) {
          // 采纳计数已在 runResumeAttempts 内完成（含被拒后重试的创建次数）。
          resumeChars = partialContent.length;
          resumeBaseId = lastChunkId;
          skipNextRoleOnlyChunk = true;
          resumeSegment = true;
          activeStream = nextStream;
          continue streamLoop;
        }
      }

      throw error;
    }

    break;
  }

  await emitRestorerTail();

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    ensureHeaders();
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }

  return {
    // A resumed request has no complete first-attempt usage to combine with
    // the continuation's usage. Callers must count the stitched stream.
    promptTokens: resumeSegment ? 0 : promptTokens,
    completionTokens: resumeSegment ? 0 : completionTokens,
    totalTokens: resumeSegment ? 0 : totalTokens,
    cachedTokens: resumeSegment ? 0 : cachedTokens,
    streamChunks: chunkRecorder.chunks,
    tffbMs,
    streamResumed: resumeSegment,
    // 上游续写请求创建次数（含 429 重试；初始请求不计）；仅在采纳了续写段
    // （成功收尾）时上报 —— 失败路径保持原始错误终态，不带续写 metadata。
    streamResumeAttempts: resumeSegment ? resumeAttempts : undefined,
    streamResumeChars: resumeSegment ? resumeChars : undefined,
    reasoningContent: reasoningContent || undefined,
    thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
  };
}
