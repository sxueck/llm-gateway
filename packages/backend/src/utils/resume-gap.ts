import type { FastifyReply } from 'fastify';

import { writeWithBackpressure } from './stream-guards.js';
// Reuse the chat processor's public resume contract (types only — no runtime
// dependency on the chat path) so both protocols speak the same factory shape.
import type { ResumeStreamOutcome, StreamResumeRetryOptions } from './stream-processor.js';

/**
 * Shared continuation-request defaults for the Responses stream resume path.
 * They mirror the (chat-embedded) constants in stream-processor.ts so both
 * protocols behave identically; the chat file keeps its own private copies
 * and is intentionally left untouched.
 */
export const STREAM_RESUME_MAX_CHARS = 64 * 1024;

const STREAM_RESUME_MAX_REQUEST_ATTEMPTS = 3;
const STREAM_RESUME_DEFAULT_BACKOFF_MS = 500;
const STREAM_RESUME_MAX_RETRY_AFTER_MS = 60_000;
const STREAM_RESUME_HEARTBEAT_INTERVAL_MS = 5_000;

// SSE 规范要求客户端忽略以 ':' 开头的行，因此心跳不会干扰任何解析器。
const STREAM_RESUME_HEARTBEAT_FRAME = ': ping\n\n';

type ResumeGapLogger = {
  info: (msg: string, tag?: string) => void;
  warn?: (msg: string, tag?: string) => void;
};

export interface ResolvedResumeRetryOptions {
  maxAttempts: number;
  defaultBackoffMs: number;
  maxRetryAfterMs: number;
  heartbeatIntervalMs: number;
}

function resolveResumeRetryNumber(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

export function resolveResumeRetryOptions(
  options: StreamResumeRetryOptions | undefined
): ResolvedResumeRetryOptions {
  return {
    maxAttempts: resolveResumeRetryNumber(
      options?.maxAttempts,
      STREAM_RESUME_MAX_REQUEST_ATTEMPTS,
      1
    ),
    defaultBackoffMs: resolveResumeRetryNumber(
      options?.defaultBackoffMs,
      STREAM_RESUME_DEFAULT_BACKOFF_MS,
      0
    ),
    maxRetryAfterMs: resolveResumeRetryNumber(
      options?.maxRetryAfterMs,
      STREAM_RESUME_MAX_RETRY_AFTER_MS,
      0
    ),
    heartbeatIntervalMs: resolveResumeRetryNumber(
      options?.heartbeatIntervalMs,
      STREAM_RESUME_HEARTBEAT_INTERVAL_MS,
      0
    ),
  };
}

export interface ResumeRunAttemptsOptions {
  /** Partial plain text already delivered downstream (raw, pre-restore). */
  partialText: string;
  /** Continuation factory; contract: never throws (map errors to ResumeStreamOutcome). */
  factory: (partialText: string) => Promise<AsyncIterable<any> | ResumeStreamOutcome | null>;
  /** Runs once before the first attempt (e.g. flush a PII-restorer tail). */
  beforeAttempts?: () => Promise<void>;
}

export interface ResumeGapRunner {
  retry: ResolvedResumeRetryOptions;
  clientGone(): boolean;
  /** Waits `delayMs` keeping the SSE connection warm; true = client vanished. */
  wait(delayMs: number): Promise<boolean>;
  /** Retry creation with heartbeats and Retry-After; stop when the client disconnects. */
  runAttempts(options: ResumeRunAttemptsOptions): Promise<ResumeAttemptsResult>;
}

/** Outcome of ResumeGapRunner.runAttempts. */
export interface ResumeAttemptsResult {
  /** Adopted continuation stream; null keeps the original failure terminal. */
  stream: AsyncIterable<any> | null;
  /** Continuation requests actually created upstream (429-rejected creations
   * included); the initial request is never counted. */
  createdRequests: number;
}

/** Controls the gap between an upstream failure and the continuation's first event. */
export function createResumeGapRunner(deps: {
  reply: FastifyReply;
  responseHeaders: Record<string, string>;
  abortSignal?: AbortSignal;
  logger?: ResumeGapLogger;
  retry?: StreamResumeRetryOptions;
}): ResumeGapRunner {
  const { reply, responseHeaders, abortSignal, logger } = deps;
  const retry = resolveResumeRetryOptions(deps.retry);

  const clientGone = (): boolean =>
    abortSignal?.aborted === true || reply.raw.destroyed || reply.raw.writableEnded;

  // 返回 false 表示客户端已不在（心跳写不出去或已 abort）。
  const writeHeartbeat = async (): Promise<boolean> => {
    if (clientGone()) return false;
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(200, responseHeaders);
    }
    // 心跳是传输层保活：调用方不把它记入 chunk 序列（token 计数/重放）。
    await writeWithBackpressure(reply.raw, STREAM_RESUME_HEARTBEAT_FRAME, abortSignal);
    return !clientGone();
  };

  const sleepGap = (ms: number): Promise<void> =>
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

  const waitGap = async (delayMs: number): Promise<boolean> => {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, delayMs);
    const interval = retry.heartbeatIntervalMs;
    let nextBeatAt = interval > 0 ? startedAt + interval : Number.POSITIVE_INFINITY;
    while (true) {
      if (clientGone()) return true;
      const now = Date.now();
      if (now >= deadline) return false;
      if (now >= nextBeatAt) {
        if (!(await writeHeartbeat())) return true;
        nextBeatAt += interval;
        continue;
      }
      await sleepGap(Math.min(deadline, nextBeatAt) - now);
    }
  };

  /** Awaits the continuation factory while ticking heartbeats over the gap.
   * Returns { clientGone: true } when the downstream client disappears
   * first; the pending factory promise stays error-guarded. */
  const awaitFactory = async (
    pending: Promise<any>
  ): Promise<{ clientGone: boolean; value?: any }> => {
    // The race below owns rejections while it is pending; if the heartbeat
    // side wins first, a later rejection must not surface as unhandled.
    void pending.catch(() => {});

    if (retry.heartbeatIntervalMs <= 0) {
      const value = await pending;
      return { clientGone: clientGone(), value };
    }

    const CLIENT_GONE = Symbol('resume-client-gone');
    let beatTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    try {
      const beating = new Promise<typeof CLIENT_GONE>((resolveBeat, rejectBeat) => {
        const tick = () => {
          if (stopped) return;
          if (clientGone()) {
            resolveBeat(CLIENT_GONE);
            return;
          }
          void (async () => {
            if (!(await writeHeartbeat())) {
              resolveBeat(CLIENT_GONE);
              return;
            }
            if (!stopped) beatTimer = setTimeout(tick, retry.heartbeatIntervalMs);
          })().catch(rejectBeat);
        };
        beatTimer = setTimeout(tick, retry.heartbeatIntervalMs);
      });

      const winner = await Promise.race([pending, beating]);
      if (winner === CLIENT_GONE) return { clientGone: true };
      return { clientGone: false, value: winner };
    } finally {
      stopped = true;
      clearTimeout(beatTimer);
    }
  };

  const runAttempts = async (options: ResumeRunAttemptsOptions): Promise<ResumeAttemptsResult> => {
    const { partialText, factory, beforeAttempts } = options;
    // 已真实创建并发往上游的续写请求次数（含被拒后的重试）。
    let createdRequests = 0;

    // 先把还原器扣下的尾巴交给客户端，再清空它，避免接到续写开头。
    if (beforeAttempts) await beforeAttempts();
    if (clientGone()) return { stream: null, createdRequests };

    let advisedWaitMs: number | undefined;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (attempt > 1) {
        // Do not retry earlier than the server requested. A delay beyond our
        // bounded resume window is terminal instead of being silently clamped.
        if (advisedWaitMs !== undefined && advisedWaitMs > retry.maxRetryAfterMs) {
          logger?.warn?.('断点续传: Retry-After 超出等待上限，停止重试', 'Protocol');
          return { stream: null, createdRequests };
        }
        const waitMs = advisedWaitMs ?? retry.defaultBackoffMs;
        logger?.info(
          `断点续传: 续写请求创建失败，${waitMs}ms 后进行第 ${attempt}/${retry.maxAttempts} 次尝试` +
            (advisedWaitMs !== undefined ? '（遵循上游 Retry-After）' : ''),
          'Protocol'
        );
        if (await waitGap(waitMs)) return { stream: null, createdRequests };
      }

      let factoryValue: any;
      try {
        const outcome = await awaitFactory(Promise.resolve(factory(partialText)));
        if (outcome.clientGone) return { stream: null, createdRequests };
        factoryValue = outcome.value;
      } catch {
        // 工厂契约是“从不抛出”（protocol-adapter 已把上游错误映射为
        // ResumeStreamOutcome）；意外抛出保持终态，不掩盖原始错误。
        return { stream: null, createdRequests };
      }

      let nextStream: AsyncIterable<any> | null = null;
      let retryable = false;
      let retryAfterMs: number | undefined;
      if (factoryValue && typeof factoryValue === 'object' && 'stream' in factoryValue) {
        nextStream = factoryValue.stream ?? null;
        retryable = factoryValue.retryable === true;
        const advised = factoryValue.retryAfterMs;
        retryAfterMs =
          typeof advised === 'number' && Number.isFinite(advised) && advised >= 0
            ? advised
            : undefined;
        // ResumeStreamOutcome = 续写请求已真实创建但被上游拒绝（429/5xx 等）。
        createdRequests += 1;
      } else {
        nextStream = (factoryValue ?? null) as AsyncIterable<any> | null;
        // 返回流 = 续写请求已创建且成功。返回 null = 未创建（开关关闭等）。
        if (nextStream !== null) createdRequests += 1;
      }

      if (nextStream) {
        logger?.warn?.(
          `断点续传: 上游流中断(已输出 ${partialText.length} 字符)，续写请求成功(第 ${attempt} 次尝试)`,
          'Protocol'
        );
        return { stream: nextStream, createdRequests };
      }

      if (!retryable || attempt >= retry.maxAttempts) {
        return { stream: null, createdRequests };
      }
      advisedWaitMs = retryAfterMs;
    }
    return { stream: null, createdRequests };
  };

  return {
    retry,
    clientGone,
    wait: waitGap,
    runAttempts,
  };
}
