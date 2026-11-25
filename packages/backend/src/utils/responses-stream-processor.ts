import type { FastifyReply } from 'fastify';

import { normalizeUsageCounts } from './usage-normalizer.js';
import { BoundedChunkRecorder } from './bounded-chunk-recorder.js';
import { createInitialAggregate, processResponsesEvent, type ResponsesAggregate } from './responses-parser.js';
import { EmptyOutputError } from '../errors/empty-output-error.js';
import { StreamTruncatedError, withStreamIdleTimeout, writeWithBackpressure } from './stream-guards.js';
import { createResumeGapRunner, STREAM_RESUME_MAX_CHARS } from './resume-gap.js';
import { sanitizeUpstreamRequestId, UPSTREAM_REQUEST_ID_HEADER } from './upstream-request-id.js';
// 复用 chat 处理器导出的续写契约（仅类型，不引入 chat 运行时依赖）。
import type { ResumeStreamOutcome, StreamResumeRetryOptions } from './stream-processor.js';

// Responses API 空输出重试默认次数（可通过环境变量或模型属性配置）
export const DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES = Math.max(
  parseInt(process.env.RESPONSES_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

type SyncStreamRestorer = {
  process: (key: string, content: string) => string;
  flush: (key: string) => string;
  /** Complete-field restore. Must not touch the incremental output_text buffer. */
  restoreObject?: (body: any) => void;
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

  // 官方 Responses 流式增量为纯字符串（`delta: "…"`），不是包装对象。
  if (
    typeof event.type === 'string' &&
    event.type.includes('output_text.delta') &&
    typeof event.delta === 'string' &&
    (event.delta as string).length > 0
  ) {
    return true;
  }

  return false;
}

/** Events after which an upstream Responses stream is legitimately complete. */
const TERMINAL_RESPONSE_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  'response.done',
]);

const RESPONSES_CLOSE_EVENTS = new Set<string>([
  'response.output_text.done',
  'response.content_part.done',
  'response.output_item.done',
  ...TERMINAL_RESPONSE_EVENTS,
]);

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
  /** Max silence between upstream events once the stream has started; 0/undefined disables. */
  streamIdleTimeoutMs?: number;
  streamRestorer?: SyncStreamRestorer | null;

  /** 断点续传：与 chat 路径同一契约。基于已下发的纯文本构造续写流；
   * 构造方必须禁用工具调用（见 services/stream-resumer.ts），
   * 处理器只保证恰好采纳一段纯文本续写。返回流或 ResumeStreamOutcome
   * 都意味着续写请求已真实创建（计入 streamResumeAttempts，含 429
   * 拒绝后的重试）；返回 null 表示未创建，不计入。 */
  resumeStreamFactory?: (
    partialText: string
  ) => Promise<AsyncIterable<any> | ResumeStreamOutcome | null>;

  /** 续写请求自身创建失败时的重试调参（Retry-After 感知）。 */
  resumeRetry?: StreamResumeRetryOptions;

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
  streamResumed?: boolean;
  streamResumeAttempts?: number;
  streamResumeChars?: number;
  /** 非空 = 本次尝试以合成 response.failed 终态收尾：下游已收到显式失败
   * （failed + [DONE]），但调用方不得将其审计为成功。 */
  streamFailure?: { code: string; message: string };
  /** 已交付给客户端的完整 output_text（原始段 + 续写段 + 还原器尾巴），
   * 即合成终态所用的 clientText 原文；仅在采纳了续写段（成功收尾或
   * 合成失败收尾）时上报。与磁带截断无关：续传计费直接对完整文本按
   * 真实分词器计数，磁带保持原样仅供日志。 */
  deliveredOutputText?: string;
}

const RESPONSES_PENDING_CHARS_LIMIT = 1024 * 1024;

class SseWriter {
  private readonly recorded = new BoundedChunkRecorder();
  private readonly pending: string[] = [];
  private pendingChars = 0;
  private phase: AttemptPhase = 'buffering';

  constructor(
    private readonly reply: FastifyReply,
    private readonly responseHeaders: Record<string, string>,
    private readonly getUpstreamRequestId: () => string | null
  ) {}

  private ensureHeadersSent(): void {
    if (!this.reply.raw.headersSent) {
      const upstreamRequestId = this.getUpstreamRequestId();
      if (upstreamRequestId) {
        this.responseHeaders[UPSTREAM_REQUEST_ID_HEADER] = upstreamRequestId;
      }
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
    await writeWithBackpressure(this.reply.raw, data);
  }

  /** Buffer a frame while in the buffering phase. */
  async enqueue(data: string): Promise<void> {
    if (this.phase === 'buffering') {
      this.pendingChars += data.length;
      if (this.pendingChars > RESPONSES_PENDING_CHARS_LIMIT) {
        const overflow: any = new Error('Responses upstream sent too much data before any output');
        overflow.status = 502;
        throw overflow;
      }
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
    streamIdleTimeoutMs?: number;
    streamRestorer?: SyncStreamRestorer | null;
    resumeStreamFactory?: (
      partialText: string
    ) => Promise<AsyncIterable<any> | ResumeStreamOutcome | null>;
    resumeRetry?: StreamResumeRetryOptions;
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
    streamIdleTimeoutMs,
    streamRestorer,
    resumeStreamFactory,
    resumeRetry,
  } = deps;

  let upstreamRequestId: string | null = null;
  const writer = new SseWriter(reply, responseHeaders, () => upstreamRequestId);

  // Per-attempt state
  const attemptStartedAt = Date.now();
  let attemptTffbMs: number | undefined;
  let hasAssistantOutput = false;
  let bypassEmptyGuard = false;
  let aggregate: ResponsesAggregate = createInitialAggregate();
  let bufferedOutputKeyUsed = false;
  // 上游 output_text.delta 的线路形态：官方为纯字符串，部分上游包装为对象。
  // 还原器扣下尾巴补发合成增量时必须保持同一形态。
  let stringDeltaShape = false;
  let tailItemId: string | undefined;
  let tailOutputIndex: number | undefined;
  let tailContentIndex: number | undefined;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;

  const attemptAbortController = new AbortController();
  let initTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let initTimedOut = false;
  if (initTimeoutMs > 0) {
    initTimeoutId = setTimeout(() => {
      initTimedOut = true;
      attemptAbortController.abort();
    }, initTimeoutMs);
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
    // The SDK exposes the selected attempt's headers without consuming the stream.
    const created = client.responses.create(
      requestParams,
      attemptUpstreamRequestOptions
    );
    if (created && typeof (created as any).withResponse === 'function') {
      const withResponse = await (created as any).withResponse();
      stream = withResponse?.data as AsyncIterable<any>;
      upstreamRequestId = sanitizeUpstreamRequestId(withResponse?.request_id);
    } else {
      stream = (await created) as unknown as AsyncIterable<any>;
    }
  } catch (error: any) {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler as any);
    }
    if (initTimedOut && !abortSignal?.aborted) {
      const timeoutError: any = new Error(`Upstream did not start the stream within ${initTimeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (initTimeoutId) {
      clearTimeout(initTimeoutId);
    }
  }

  stream = withStreamIdleTimeout(stream, streamIdleTimeoutMs ?? 0, () => attemptAbortController.abort());
  let sawTerminalEvent = false;
  let clientGone = false;

  // --- 断点续传（stream resume）状态 ---------------------------------------
  // 仅支持“纯文本”续写：原始流必须只产出单个 message 项的 output_text。
  // 工具调用/推理/refusal/注释等会使拼接不可靠，一旦出现即保持原始失败为终态。
  // 续写请求由 resumeStreamFactory 构造（禁用工具），这里最多采纳一段续写；
  // 工厂返回流或 ResumeStreamOutcome 都意味着续写请求已真实发往上游（计入
  // streamResumeAttempts，含 429 拒绝后的重试）。
  const gapRunner = resumeStreamFactory
    ? createResumeGapRunner({ reply, responseHeaders, abortSignal, logger, retry: resumeRetry })
    : null;

  let activeStream: AsyncIterable<any> = stream;
  // resumeSegment：是否已采纳一段续写（终局门闩 —— 采纳过就绝不再续）。
  let resumeSegment = false;
  // resumeAttempts：已真实创建并发往上游的续写请求次数（含被 429/5xx 拒绝
  // 后的重试；初始请求不计），由 ResumeGapRunner.runAttempts 统计上报。
  let resumeAttempts = 0;
  let resumeChars = 0;
  // 原始（未还原）部分文本：续写提示必须用上游原文送回上游。
  let resumePartialText = '';
  // 下游可见（还原后）累计文本：用于合成终止序列。
  let clientText = '';
  // 正在续写的 message 项身份：续写事件全部重写回该身份，保持 response/item 稳定。
  let resumeItemId: string | undefined;
  let resumeOutputIndex = 0;
  let resumeContentIndex = 0;
  let resumeContentIndexKnown = false;
  let resumeItemKnown = false;
  let resumeIneligibleReason: string | undefined;
  // 合成 failed 终态（synthesizeResumeFailure）的审计信号：显式向调用方
  // 表达失败，不得以 success:true 伪造成功（下游帧仍完整）。
  let synthesizedFailure: { code: string; message: string } | undefined;
  // 合成终态实际下发的权威全文（原始段+续写段原文一次性还原；
  // 仅在采纳了续写段时赋值）。与增量累计值可能不同：间隙尾巴若把
  // 跨断点的占位符从中间切开，增量累计值将永远带着假掩码，而全文
  // 一次性还原能修复它——官方语义以 output_text.done/终态快照为准。
  let synthesizedOutputText: string | undefined;
  // 续写段终态（合成 failed 或 completed 终止序列）下发之后，不得再向
  // 下游转发任何事件——增量绝不能出现在终态之后。
  let resumeTerminalEmitted = false;
  // sequence_number 记账：原始流一旦使用过该字段，续写段的所有事件
  // （转发增量与合成事件）都在原始最大值之后单调重编号；原始流从未
  // 使用时保持字段缺省（并剥掉续写流自带编号），正常非续传输出不变。
  let sequenceNumbersObserved = false;
  let lastSequenceNumber = 0;
  // 原始流的最新 response 快照（created/in_progress/completed 等事件携带）。
  let lastResponseSnapshot: any;
  // 续写流转发状态。
  let continuationTerminal: { type: string; response?: any } | null = null;
  const continuationNonTextItemIds = new Set<string>();

  const markResumeIneligible = (reason: string): void => {
    if (resumeIneligibleReason === undefined) resumeIneligibleReason = reason;
  };

  /** Records identity/eligibility facts from an original-segment event. */
  const trackResumeEligibility = (chunk: any): void => {
    const type = String(chunk?.type || '');

    if (type === 'response.output_item.added') {
      const itemType = String(chunk?.item?.type || '');
      if (itemType && itemType !== 'message') {
        markResumeIneligible(`非文本输出项 ${itemType}`);
        return;
      }
      const itemId = chunk?.item?.id;
      if (typeof itemId === 'string' && itemId) {
        if (!resumeItemKnown) {
          resumeItemKnown = true;
          resumeItemId = itemId;
          resumeOutputIndex = typeof chunk.output_index === 'number' ? chunk.output_index : 0;
        } else if (itemId !== resumeItemId) {
          markResumeIneligible('多个 message 输出项');
        }
      }
      return;
    }

    if (type === 'response.output_text.delta') {
      const itemId = chunk?.item_id;
      if (typeof itemId === 'string' && itemId) {
        if (!resumeItemKnown) {
          resumeItemKnown = true;
          resumeItemId = itemId;
          resumeOutputIndex = typeof chunk.output_index === 'number' ? chunk.output_index : 0;
        } else if (itemId !== resumeItemId) {
          markResumeIneligible('文本增量属于另一个输出项');
        }
      }
      const contentIndex = typeof chunk.content_index === 'number' ? chunk.content_index : 0;
      if (!resumeContentIndexKnown) {
        resumeContentIndexKnown = true;
        resumeContentIndex = contentIndex;
      } else if (contentIndex !== resumeContentIndex) {
        markResumeIneligible('文本增量属于另一个 content part');
      }
      if (resumeContentIndex !== 0) {
        markResumeIneligible(`非零 content_index ${resumeContentIndex}`);
      }
      return;
    }

    if (type === 'response.content_part.added') {
      const contentIndex = typeof chunk.content_index === 'number' ? chunk.content_index : 0;
      if (!resumeContentIndexKnown) {
        resumeContentIndexKnown = true;
        resumeContentIndex = contentIndex;
      } else if (contentIndex !== resumeContentIndex) {
        markResumeIneligible('多个 content part');
      }
      if (resumeContentIndex !== 0) {
        markResumeIneligible(`非零 content_index ${resumeContentIndex}`);
      }
      const partType = String(chunk?.part?.type || 'output_text');
      if (partType !== 'output_text') {
        markResumeIneligible(`content part 类型 ${partType}`);
      }
      return;
    }

    if (
      type.startsWith('response.reasoning') ||
      type.startsWith('response.refusal') ||
      type.startsWith('response.output_text.annotation') ||
      type === 'response.output_text.done' ||
      type === 'response.content_part.done' ||
      type === 'response.output_item.done' ||
      /function_call|tool_call|web_search|file_search|computer|code_interpreter|image_generation|local_shell|mcp/.test(
        type
      )
    ) {
      // 输出项已关闭（done）后不能再追加增量；其余事件类型不可拼接。
      markResumeIneligible(`事件 ${type}`);
    }
  };

  /** Delta text in both wire shapes: official `delta: "…"` and wrapped `delta: {text}`. */
  const extractDeltaText = (chunk: any): string => {
    const delta: any = chunk?.delta;
    if (typeof delta === 'string') return delta;
    if (delta && typeof delta === 'object' && typeof delta.text === 'string') return delta.text;
    if (typeof chunk?.text === 'string') return chunk.text;
    return '';
  };

  const originalResponseId = (): string | undefined => {
    if (typeof lastResponseSnapshot?.id === 'string' && lastResponseSnapshot.id) {
      return lastResponseSnapshot.id;
    }
    return typeof aggregate.id === 'string' && aggregate.id ? aggregate.id : undefined;
  };

  /** 记录原始流事件的 sequence_number（只取最大值，不改动透传事件）。*/
  const observeSequenceNumber = (event: any): void => {
    const seq = event?.sequence_number;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      sequenceNumbersObserved = true;
      if (seq > lastSequenceNumber) lastSequenceNumber = seq;
    }
  };

  /** 为续写段事件分配单调递增的 sequence_number。原始流从未使用该字段时
   * 不引入编号（并剥掉续写流自带的编号），避免中途出现回退的编号序列。*/
  const renumberSequence = (event: any): void => {
    if (sequenceNumbersObserved) {
      lastSequenceNumber += 1;
      event.sequence_number = lastSequenceNumber;
    } else if (event && typeof event === 'object' && 'sequence_number' in event) {
      delete event.sequence_number;
    }
  };

  /** 转发续写流事件：只透传文本增量；头部事件（created/in_progress/
   * output_item.added/content_part.added）与成功终止事件（completed/
   * incomplete/done/output_text.done/…）一律吞掉——终止序列由
   * synthesizeResumeTail 基于拼接文本合成，保证不重复。
   * 失败终止由 synthesizeResumeFailure 合成（保留原始身份、全部文本与错误）。
   * 内容承载但无法拼接的事件（非文本/工具输出项等）不得静默丢弃后伪造
   * 成功——一律失败终止。终态下发后忽略后续一切事件。*/
  const relayContinuationChunk = async (chunk: any): Promise<void> => {
    if (resumeTerminalEmitted) return; // 终态之后不得再转发任何事件（尤其增量）
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    const type = String(chunk?.type || '');

    // 错误事件（response.failed / response.error / 任何携带顶层 .error 的
    // 事件）不得静默吞掉：以原始身份合成 failed 终态并保留错误与全文。
    // 官方 response.failed 的错误在 response.error 里，
    // classifyStreamErrorEvent 识别不到，这里显式按失败终止处理。
    const errorInfo = classifyStreamErrorEvent(chunk);
    if (type === 'response.failed' || errorInfo) {
      await synthesizeResumeFailure({
        fallbackMessage: errorInfo?.message || 'Upstream returned a stream error',
        upstreamError: chunk?.response?.error ?? chunk?.error ?? null,
        contResponse: chunk?.response,
      });
      return;
    }

    if (type === 'response.output_item.added') {
      const itemType = String(chunk?.item?.type || '');
      const itemId = chunk?.item?.id;
      if (itemType && itemType !== 'message') {
        // 非文本/工具输出项无法拼进纯文本续写：失败终止，绝不静默丢弃。
        if (typeof itemId === 'string') continuationNonTextItemIds.add(itemId);
        logger?.warn?.(
          `断点续传: 续写流出现无法拼接的非文本输出项(${itemType})，转为失败终止`,
          'Protocol'
        );
        await synthesizeResumeFailure({
          fallbackMessage: `Continuation stream produced an unsupported ${itemType} output item`,
        });
        return;
      }
      return; // 下游已持有原始 message 项，不再重复项头部。
    }

    if (type === 'response.output_text.delta') {
      if (typeof chunk.item_id === 'string' && continuationNonTextItemIds.has(chunk.item_id)) return;
      const text = extractDeltaText(chunk);
      if (!text) return;
      // 重写身份：让下游累加器在原始项上追加，而不是开新项。
      if (resumeItemId !== undefined && typeof chunk.item_id === 'string') {
        chunk.item_id = resumeItemId;
      }
      if (typeof chunk.output_index === 'number') chunk.output_index = resumeOutputIndex;
      if (typeof chunk.content_index === 'number') chunk.content_index = resumeContentIndex;
      // 续写段的原文也计入全文记账：合成终态的权威全文 = 原始段 + 续写段
      // 的上游原文（还原前）一次性还原——这样才能修复跨断点被切开的占位符。
      resumePartialText += text;
      renumberSequence(chunk);
      // 与原始段相同的还原策略：官方字符串 delta 与包装形态 delta.text 都走还原器。
      if (streamRestorer) {
        const contDelta: any = chunk.delta;
        if (typeof contDelta === 'string') {
          bufferedOutputKeyUsed = true;
          stringDeltaShape = true;
          chunk.delta = streamRestorer.process('responses:output_text', contDelta);
        } else if (contDelta && typeof contDelta === 'object' && typeof contDelta.text === 'string') {
          bufferedOutputKeyUsed = true;
          chunk.delta.text = streamRestorer.process('responses:output_text', contDelta.text);
        }
      }
      await writer.enqueue(serializeChunkToSse(chunk));
      const outDelta: any = chunk.delta;
      clientText +=
        outDelta && typeof outDelta === 'object' && typeof outDelta.text === 'string'
          ? outDelta.text
          : typeof outDelta === 'string'
            ? outDelta
            : text;
      return;
    }

    if (TERMINAL_RESPONSE_EVENTS.has(type)) {
      sawTerminalEvent = true;
      // completed/incomplete/done：吞掉，稍后合成原始身份的终止序列。
      continuationTerminal = { type, response: chunk?.response };
      return;
    }

    // 内容承载但无法拼接的事件（reasoning/refusal/annotation/工具类增量）：
    // 静默丢弃后再合成 completed 即伪造成功，保守地失败终止。
    if (
      type.startsWith('response.reasoning') ||
      type.startsWith('response.refusal') ||
      type.startsWith('response.output_text.annotation') ||
      /function_call|tool_call|web_search|file_search|computer|code_interpreter|image_generation|local_shell|mcp/.test(
        type
      )
    ) {
      logger?.warn?.(`断点续传: 续写流出现无法拼接的事件(${type})，转为失败终止`, 'Protocol');
      await synthesizeResumeFailure({
        fallbackMessage: `Continuation stream produced unsupported event ${type}`,
      });
      return;
    }

    if (type === 'response.content_part.added') {
      const partType = String(chunk?.part?.type || 'output_text');
      if (partType !== 'output_text') {
        logger?.warn?.(
          `断点续传: 续写流出现无法拼接的 content part(${partType})，转为失败终止`,
          'Protocol'
        );
        await synthesizeResumeFailure({
          fallbackMessage: `Continuation stream produced an unsupported ${partType} content part`,
        });
        return;
      }
      return; // 头部事件：吞掉
    }

    // 其余事件（created/in_progress/content_part.done/output_text.done/…）一律抑制。
  };

  /** 把还原器扣下的尾巴以增量形式交给客户端（流结束时；收尾/终态事件
   * 之前）。终态已下发后不得再补增量（增量不能出现在终态之后）。
   * 注意：合成增量不携带 sequence_number——透传事件必须保持上游原号，
   * 而上游下一个事件的编号只有收到后才知道；真实 SDK 聚合器
   * （ResponseStream）不校验该字段的连续性，官方重放语义也不受影响。*/
  const emitRestorerTail = async (renumber: boolean): Promise<void> => {
    if (resumeTerminalEmitted) return;
    if (!streamRestorer || !bufferedOutputKeyUsed || reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }
    const flushText = streamRestorer.flush('responses:output_text');
    if (!flushText) return;

    const flushEvent: any =
      stringDeltaShape
        ? { type: 'response.output_text.delta', delta: flushText }
        : { type: 'response.output_text.delta', delta: { text: flushText } };
    if (tailItemId !== undefined) {
      flushEvent.item_id = tailItemId;
      flushEvent.output_index = tailOutputIndex;
      flushEvent.content_index = tailContentIndex;
    }
    if (renumber) renumberSequence(flushEvent);
    clientText += flushText;
    await writer.enqueue(serializeChunkToSse(flushEvent));
  };

  /** 对整段文本做一次纯还原且不残留缓冲。只能在还原器 pending 为空时
   * 调用（即尾巴已补发之后）：process 会把文本并入 pending，flush 立即
   * 归还全部还原结果并清空 pending，故该操作自身保持不变量。 */
  const restoreFullTextOnce = (text: string): string => {
    const through = streamRestorer!.process('responses:output_text', text);
    return through + streamRestorer!.flush('responses:output_text');
  };

  /** 完整字段还原，不占用 output_text 增量缓冲。 */
  const restoreSnapshotText = (text: string): string => {
    const through = streamRestorer!.process('responses:snapshot', text);
    return through + streamRestorer!.flush('responses:snapshot');
  };

  /** 还原收尾/终态事件携带的完整文本：output_text.done.text、
   * content_part.done.part.text、output_item.done 与终态快照中 message
   * content 的 output_text。上游官方流的这些字段是增量全文的权威快照，
   * SDK finalResponse 直接采用它们——不还原就会向下游泄漏掩码占位符。 */
  const restoreCloseEventText = (chunk: any): void => {
    if (!streamRestorer || !chunk || typeof chunk !== 'object') return;
    const type = String(chunk.type || '');

    const restorePart = (part: any): void => {
      if (!part || typeof part !== 'object') return;
      const partType = String(part.type || 'output_text');
      if (partType === 'output_text' || partType === 'text') {
        if (typeof part.text === 'string' && part.text.length > 0) {
          part.text = restoreFullTextOnce(part.text);
        }
        return;
      }
      if (
        (partType === 'input_text' || partType === 'summary_text' || partType === 'reasoning_text') &&
        typeof part.text === 'string' && part.text.length > 0
      ) {
        part.text = restoreSnapshotText(part.text);
        return;
      }
      if (partType === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0) {
        part.refusal = restoreSnapshotText(part.refusal);
      }
    };

    if (type === 'response.output_text.done') {
      if (typeof chunk.text === 'string' && chunk.text.length > 0) {
        chunk.text = restoreFullTextOnce(chunk.text);
      }
      return;
    }

    if (type === 'response.content_part.done') {
      restorePart(chunk.part);
      return;
    }

    const restoreMessageItem = (item: any): void => {
      if (!item || typeof item !== 'object') return;
      if (Array.isArray(item.content)) {
        for (const part of item.content) restorePart(part);
      }
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) restorePart(part);
      }
    };

    if (type === 'response.output_item.done') {
      restoreMessageItem(chunk.item);
      return;
    }

    if (TERMINAL_RESPONSE_EVENTS.has(type)) {
      const response: any = chunk.response;
      if (response && typeof response === 'object' && Array.isArray(response.output)) {
        for (const item of response.output) restoreMessageItem(item);
      }
    }
  };

  /** 合成终态的权威全文：原始段+续写段的上游原文（还原前）做一次
   * 性还原。只能在还原器 pending 为空时调用（即尾巴已补发之后）。 */
  const authoritativeFinalText = (): string =>
    streamRestorer ? restoreFullTextOnce(resumePartialText) : clientText;

  /** 以原始 response 身份合成唯一的 response.failed 终态：
   * 先 flush 还原器（增量必须在终态之前），再下发携带原始 id、全部
   * 已交付文本与（续写流报告的）错误的失败事件；不透传续写流的快照
   * （那会丢掉原始段文本），随后也不再合成任何事件。*/
  const synthesizeResumeFailure = async (opts: {
    fallbackMessage: string;
    upstreamError?: any;
    contResponse?: any;
  }): Promise<void> => {
    if (resumeTerminalEmitted) return;
    bypassEmptyGuard = true;
    sawTerminalEvent = true;
    continuationTerminal = null; // 不再合成 completed/incomplete
    if (clientGone || reply.raw.destroyed || reply.raw.writableEnded) {
      resumeTerminalEmitted = true;
      return;
    }

    await writer.flush();
    // 先把还原器扣下的尾巴以增量交付（增量必须在终态之前）。
    await emitRestorerTail(true);
    // 权威全文：修复被断点从中间切开的占位符（全文一次性还原）。
    const finalText = authoritativeFinalText();
    synthesizedOutputText = finalText;

    const responseId = originalResponseId();
    const snapshot =
      lastResponseSnapshot && typeof lastResponseSnapshot === 'object' ? lastResponseSnapshot : {};
    const contResponse = opts.contResponse;
    const error: any =
      opts.upstreamError && typeof opts.upstreamError === 'object'
        ? { ...opts.upstreamError }
        : {};
    if (!error.code) error.code = 'server_error';
    if (typeof error.message !== 'string' || !error.message) {
      error.message = opts.fallbackMessage;
    }
    // 审计信号：调用方（路由/计费侧）必须看到明确失败。
    synthesizedFailure = { code: String(error.code), message: String(error.message) };

    const part = { type: 'output_text', text: finalText, annotations: [] };
    const outputIndex = resumeOutputIndex;
    const finalItems: any[] = Array.isArray(snapshot.output) ? [...snapshot.output] : [];
    const previousItem =
      outputIndex >= 0 && outputIndex < finalItems.length &&
      finalItems[outputIndex] && typeof finalItems[outputIndex] === 'object'
        ? finalItems[outputIndex]
        : undefined;
    const messageItem: any =
      resumeItemId !== undefined
        ? {
            ...(previousItem || {}),
            id: resumeItemId,
            type: 'message',
            role: 'assistant',
            status: 'incomplete',
            content: [part],
          }
        : { type: 'message', role: 'assistant', status: 'incomplete', content: [part] };
    if (outputIndex >= 0 && outputIndex < finalItems.length) {
      finalItems[outputIndex] = messageItem;
    } else {
      finalItems.push(messageItem);
    }

    const synthesizedResponse: any = {
      ...snapshot,
      status: 'failed',
      error,
      output: finalItems,
      usage:
        contResponse && typeof contResponse === 'object' && contResponse.usage !== undefined
          ? contResponse.usage
          : null,
    };
    if (responseId !== undefined) {
      synthesizedResponse.id = responseId;
    } else {
      delete synthesizedResponse.id;
    }

    // 终态即将下发：之后不得再向下游转发任何事件（尤其增量）。
    resumeTerminalEmitted = true;
    const failedEvent: any = { type: 'response.failed', response: synthesizedResponse };
    renumberSequence(failedEvent);
    await writer.enqueue(serializeChunkToSse(failedEvent));
  };

  /** 基于拼接文本合成缺失的尾部终止序列（恰好一次）：
   * output_text.done → content_part.done → output_item.done → completed/incomplete。*/
  const synthesizeResumeTail = async (): Promise<void> => {
    if (
      !resumeSegment ||
      !continuationTerminal ||
      resumeTerminalEmitted ||
      clientGone ||
      reply.raw.destroyed ||
      reply.raw.writableEnded
    ) {
      return; // 失败终止已由 synthesizeResumeFailure 合成，不再合成 completed。
    }
    if (resumeItemId === undefined) return; // 采纳续写段前已保证身份已知

    /** 合成事件一律获得单调递增的 sequence_number 后再下发。*/
    const emitSynthesized = async (event: any): Promise<void> => {
      renumberSequence(event);
      await writer.enqueue(serializeChunkToSse(event));
    };

    const terminalType =
      continuationTerminal.type === 'response.incomplete' ? 'response.incomplete' : 'response.completed';
    const status = terminalType === 'response.incomplete' ? 'incomplete' : 'completed';
    const itemId = resumeItemId;
    const outputIndex = resumeOutputIndex;
    const contentIndex = resumeContentIndex;
    // 权威全文：修复被断点从中间切开的占位符（全文一次性还原）。
    // 还原器 pending 已在流结束时清空，此处可安全调用。
    const finalText = authoritativeFinalText();
    synthesizedOutputText = finalText;

    await emitSynthesized({
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      text: finalText,
    });

    const part = { type: 'output_text', text: finalText, annotations: [] };
    await emitSynthesized({
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });

    // 基于原始 response 快照合成最终 response：保持 id/元数据稳定，
    // 把正在流式的 message 项替换为携带全文的完成项。
    const snapshot =
      lastResponseSnapshot && typeof lastResponseSnapshot === 'object' ? lastResponseSnapshot : {};
    const contResponse = continuationTerminal.response;
    const finalItems: any[] = Array.isArray(snapshot.output) ? [...snapshot.output] : [];
    const previousItem =
      outputIndex >= 0 && outputIndex < finalItems.length && finalItems[outputIndex] &&
      typeof finalItems[outputIndex] === 'object'
        ? finalItems[outputIndex]
        : undefined;
    const messageItem = {
      ...(previousItem || {}),
      id: itemId,
      type: 'message',
      role: 'assistant',
      status,
      content: [part],
    };
    if (outputIndex >= 0 && outputIndex < finalItems.length) {
      finalItems[outputIndex] = messageItem;
    } else {
      finalItems.push(messageItem);
    }

    const synthesizedResponse: any = {
      ...snapshot,
      status,
      output: finalItems,
      // 只把续写请求真实返回的 usage 透传给下游（与 chat 路径一致）；
      // 网关计费侧对续写请求一律置零，由 chunk 序列重新估算。
      usage: contResponse && typeof contResponse === 'object' ? contResponse.usage ?? null : null,
    };
    const responseId = originalResponseId();
    if (responseId !== undefined) {
      synthesizedResponse.id = responseId;
    } else {
      delete synthesizedResponse.id;
    }
    if (status === 'incomplete' && contResponse && typeof contResponse === 'object') {
      if (contResponse.incomplete_details !== undefined) {
        synthesizedResponse.incomplete_details = contResponse.incomplete_details;
      }
      if (contResponse.status_details !== undefined) {
        synthesizedResponse.status_details = contResponse.status_details;
      }
    }

    await emitSynthesized({ type: 'response.output_item.done', output_index: outputIndex, item: messageItem });
    resumeTerminalEmitted = true; // 终止序列已下发，之后不得再有任何事件
    await emitSynthesized({ type: terminalType, response: synthesizedResponse });
  };

  try {
    streamLoop: while (true) {
      try {
        for await (const chunk of activeStream) {
          if (reply.raw.destroyed || reply.raw.writableEnded) {
            logger?.info('客户端已断开连接，停止流式传输', 'Protocol');
            clientGone = true;
            break;
          }

          if (TERMINAL_RESPONSE_EVENTS.has((chunk as any)?.type)) {
            sawTerminalEvent = true;
          }

          if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
            delete (chunk as any).instructions;
          }

          if (attemptTffbMs === undefined) {
            attemptTffbMs = Date.now() - attemptStartedAt;
          }

          if (resumeSegment) {
            await relayContinuationChunk(chunk);
            continue;
          }

          const previousLength = aggregate.outputText.length;
          aggregate = processResponsesEvent(aggregate, chunk as any);
          const producedText = aggregate.outputText.length > previousLength;

          // 续写资格/身份记录（在任何还原改写之前，用上游原文）。
          trackResumeEligibility(chunk);
          observeSequenceNumber(chunk);
          const deltaText = extractDeltaText(chunk);
          if (deltaText) resumePartialText += deltaText;
          if (chunk?.response && typeof chunk.response === 'object') {
            lastResponseSnapshot = chunk.response;
          }

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

          // Builtin PII protection: restore masked values in stream.
          // 官方 Responses 增量是纯字符串（`delta: "…"`），部分上游包装为
          // 对象（`delta: {text}`）：两种形态都过还原器。
          const passthroughType = String((chunk as any)?.type || '');
          if (streamRestorer && passthroughType.includes('output_text.delta')) {
            if (tailItemId !== undefined && (tailItemId !== chunk.item_id ||
                tailOutputIndex !== chunk.output_index || tailContentIndex !== chunk.content_index)) {
              await emitRestorerTail(false);
            }
            tailItemId = chunk.item_id;
            tailOutputIndex = chunk.output_index;
            tailContentIndex = chunk.content_index;
            const delta: any = (chunk as any)?.delta;
            if (typeof delta === 'string') {
              bufferedOutputKeyUsed = true;
              stringDeltaShape = true;
              (chunk as any).delta = streamRestorer.process('responses:output_text', delta);
            } else if (delta && typeof delta === 'object' && typeof delta.text === 'string') {
              bufferedOutputKeyUsed = true;
              delta.text = streamRestorer.process('responses:output_text', delta.text);
            }
          }

          // 收尾/终态事件：先补发还原器扣下的缓冲尾巴（增量绝不能出现在
          // output_text.done / completed 等事件之后），再还原这些事件携带
          // 的完整文本——终态快照不得向下游泄漏掩码占位符。
          if (RESPONSES_CLOSE_EVENTS.has(passthroughType)) {
            await emitRestorerTail(false);
            restoreCloseEventText(chunk);
          }

          // created / in_progress 就会回显 instructions 与 input，不能等到终态。
          // refusal.done 的全文不在 response 上，单独还原。
          if (streamRestorer) {
            if (
              (passthroughType === 'response.refusal.delta' && typeof (chunk as any).delta === 'string') ||
              passthroughType === 'response.refusal.done'
            ) {
              const field = passthroughType === 'response.refusal.delta' ? 'delta' : 'refusal';
              if (typeof (chunk as any)[field] === 'string' && (chunk as any)[field].length > 0) {
                (chunk as any)[field] = restoreSnapshotText((chunk as any)[field]);
              }
            }
            if ((chunk as any)?.response && typeof (chunk as any).response === 'object') {
              streamRestorer.restoreObject?.((chunk as any).response);
            }
          }

          await writer.enqueue(serializeChunkToSse(chunk));

          // 下游可见文本 = 还原后的文本（官方字符串形态或包装形态），否则为上游原文。
          if (deltaText) {
            const outDelta: any = (chunk as any)?.delta;
            clientText +=
              outDelta && typeof outDelta === 'object' && typeof outDelta.text === 'string'
                ? outDelta.text
                : typeof outDelta === 'string'
                  ? outDelta
                  : deltaText;
          }

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

        // The SDK can end iteration silently after the client aborts.
        // Propagate cancellation so the route does not audit it as success
        // (mirrors the chat processor).
        if (abortSignal?.aborted) {
          const abortError: any = new Error('Client aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }

        // Flush any remaining content from builtin PII stream restorer
        // （完整流已在收尾/终态事件前补发过尾巴，此处通常无残留；
        // 被截断的流没有终态事件，仍需在此把已产出的文本尾巴交给客户端）。
        // 续传路径同步重编号；续写段若已合成失败终态，这里不会再补增量。
        await emitRestorerTail(resumeSegment);

        // 续写段成功到达终止事件：合成原始身份的终止序列（恰好一次）。
        await synthesizeResumeTail();

        // The SDK ends the iterator silently on a graceful close, so completion must be checked here.
        if (
          hasAssistantOutput &&
          !sawTerminalEvent &&
          !bypassEmptyGuard &&
          !clientGone &&
          !abortSignal?.aborted
        ) {
          throw new StreamTruncatedError('Upstream Responses stream ended before a terminal event');
        }
      } catch (error: any) {
        if (error.name === 'AbortError' || abortSignal?.aborted) {
          logger?.info('流式请求被用户取消', 'Protocol');
          throw error;
        }

        // 断点续传：原始流在纯文本已下发后中断。请求恰好一段续写；
        // 续写请求创建可按 Retry-After 重试（间隙发心跳），但续写流
        // 中途再次失败即为终态（resumeSegment 已采纳，不再续）。
        // 缺原 response id 时无法保持身份稳定，保守不续传。
        if (
          gapRunner &&
          resumeStreamFactory &&
          !resumeSegment &&
          resumeItemKnown &&
          resumeIneligibleReason === undefined &&
          originalResponseId() !== undefined &&
          resumePartialText.length > 0 &&
          resumePartialText.length <= STREAM_RESUME_MAX_CHARS &&
          !sawTerminalEvent &&
          !bypassEmptyGuard &&
          !clientGone &&
          !reply.raw.destroyed &&
          !reply.raw.writableEnded
        ) {
          let nextStream: AsyncIterable<any> | null = null;
          try {
            // 间隙中先把还原器扣下的尾巴以增量交给客户端（已提交行为：
            // 等待续写期间不留下游空窗）。若占位符恰好被断点从中间切开，
            // 这里下发的前半段拼不回完整占位符——补偿在合成终态时进行：
            // 对原始段+续写段的全文做一次性还原，作为合成
            // output_text.done/终态快照的权威全文下发（官方语义：done 的
            // text 字段即全文，SDK 聚合器会以其替换增量累计值）。
            const resumeOutcome = await gapRunner.runAttempts({
              partialText: resumePartialText,
              factory: resumeStreamFactory,
              beforeAttempts: () => emitRestorerTail(true),
            });
            nextStream = resumeOutcome.stream;
            // 上游续写请求创建次数（含 429 重试；初始请求不计）。
            resumeAttempts = resumeOutcome.createdRequests;
          } catch (resumeError) {
            if (resumeError === error) throw resumeError;
            nextStream = null;
          }
          if (nextStream) {
            resumeSegment = true;
            resumeChars = resumePartialText.length;
            activeStream = nextStream;
            logger?.warn?.(
              `断点续传: Responses 上游流中断(已输出 ${resumeChars} 字符)，采纳续写段`,
              'Protocol'
            );
            continue streamLoop;
          }
        } else if (
          resumePartialText.length > 0 &&
          resumeItemKnown &&
          !sawTerminalEvent &&
          !bypassEmptyGuard &&
          !clientGone &&
          !reply.raw.destroyed &&
          !reply.raw.writableEnded
        ) {
          const reason =
            resumeIneligibleReason !== undefined
              ? `已输出内容不可安全拼接(${resumeIneligibleReason})`
              : originalResponseId() === undefined
                ? '原始流缺少 response id，无法保持身份稳定'
                : undefined;
          if (reason !== undefined) {
            logger?.info(`断点续传: ${reason}，保持原始失败`, 'Protocol');
          }
        }

        throw error;
      }

      break;
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
    // 续写后的流没有完整、诚实的 usage 可合并（原始段 usage 从未到达，
    // 续写段 usage 只覆盖重发的提示词），计费一律置零，由 chunk 序列重新估算。
    promptTokens: resumeSegment ? 0 : promptTokens,
    completionTokens: resumeSegment ? 0 : completionTokens,
    totalTokens: resumeSegment ? 0 : totalTokens,
    cachedTokens: resumeSegment ? 0 : cachedTokens,
    streamChunks: writer.recordedChunks,
    tffbMs: attemptTffbMs,
    streamResumed: resumeSegment ? true : undefined,
    // 上游续写请求创建次数（含 429 重试；初始请求不计）；仅在采纳了续写段
    // 时上报 —— 失败路径保持原始错误终态，不带续写 metadata。
    streamResumeAttempts: resumeSegment ? resumeAttempts : undefined,
    streamResumeChars: resumeSegment ? resumeChars : undefined,
    streamFailure: synthesizedFailure,
    // 续传计费使用交付终态的完整文本，而非可能被截断的事件磁带。
    deliveredOutputText: resumeSegment ? (synthesizedOutputText ?? clientText) : undefined,
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
  streamResumed?: boolean;
  streamResumeAttempts?: number;
  streamResumeChars?: number;
  /** true = 流以合成 response.failed 终态收尾：下游已收到显式失败帧
   * （含全部已交付文本与错误，随后 [DONE]），但该请求必须按失败审计，
   * 不得因 HTTP 200 + 正常返回而记为成功。供审计/计费侧接线使用。 */
  streamFailed?: boolean;
  /** 合成失败终态携带的错误（code/message，来自上游或合成的 fallback）。 */
  streamFailure?: { code: string; message: string };
  /** 已交付给客户端的完整 output_text（原始段 + 续写段 + 还原器尾巴），
   * 即处理器合成终态所用的 clientText 原文；仅采纳了续写段（成功或合成
   * 失败收尾）时上报。与磁带截断无关：续传计费直接对完整文本按真实
   * 分词器计数，磁带保持原样仅供日志。 */
  deliveredOutputText?: string;
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
    streamIdleTimeoutMs,
    streamRestorer,
    resumeStreamFactory,
    resumeRetry,
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
        { client, requestParams, reply, responseHeaders, baseUpstreamRequestOptions, abortSignal, initTimeoutMs, streamIdleTimeoutMs, streamRestorer, resumeStreamFactory, resumeRetry },
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
          streamResumed: result.streamResumed,
          streamResumeAttempts: result.streamResumeAttempts,
          streamResumeChars: result.streamResumeChars,
          // 审计信号：合成 failed 终态显式表达失败，不伪造成功。
          streamFailed: result.streamFailure ? true : undefined,
          streamFailure: result.streamFailure,
          // 续传计费对完整终态文本计数。
          deliveredOutputText: result.deliveredOutputText,
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
