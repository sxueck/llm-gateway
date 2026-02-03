import type { FastifyReply } from 'fastify';

import { normalizeUsageCounts } from './usage-normalizer.js';
import { createInitialAggregate, processResponsesEvent } from './responses-parser.js';
import { ResponsesEmptyOutputError } from '../errors/responses-empty-output-error.js';

// Responses API 空输出重试默认次数（可通过环境变量或模型属性配置）
export const DEFAULT_RESPONSES_EMPTY_OUTPUT_MAX_RETRIES = Math.max(
  parseInt(process.env.RESPONSES_STREAM_EMPTY_RETRY_LIMIT || '1', 10),
  0
);

type SyncStreamRestorer = {
  process: (key: string, content: string) => string;
  flush: (key: string) => string;
};

type AsyncStreamRestorer = {
  process: (key: string, content: string, options: { flush: boolean }) => Promise<string>;
  flush: (key: string) => Promise<string>;
};

function responsesEventHasAssistantContent(event: any): boolean {
  if (!event || typeof event !== 'object') {
    return false;
  }

  if (typeof event.type === 'string' && event.type.startsWith('response.output_')) {
    return true;
  }

  if (Array.isArray((event as any).output) && (event as any).output.length > 0) {
    return true;
  }

  const responseOutput = (event as any).response?.output;
  if (Array.isArray(responseOutput) && responseOutput.length > 0) {
    return true;
  }

  if (event.delta && typeof event.delta === 'object' && Object.keys(event.delta).length > 0) {
    return true;
  }

  return false;
}

export interface OpenAIResponsesStreamProcessorOptions {
  client: any;
  requestParams: any;

  reply: FastifyReply;
  responseHeaders: Record<string, string>;
  baseUpstreamRequestOptions?: any;
  abortSignal?: AbortSignal;

  // Retry config
  totalAttempts: number;
  initTimeoutMs: number;

  // Optional placeholder restoration hooks.
  placeholdersMap?: any;
  restorePlaceholdersInObjectInPlace?: (obj: any, placeholdersMap: any) => void;
  streamRestorer?: SyncStreamRestorer | null;
  remoteStreamRestorer?: AsyncStreamRestorer | null;

  logger?: {
    info: (msg: string, tag?: string) => void;
    warn: (msg: string, tag?: string) => void;
    error: (msg: string, tag?: string) => void;
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
    placeholdersMap,
    restorePlaceholdersInObjectInPlace,
    streamRestorer,
    remoteStreamRestorer,
    logger,
  } = options;

  const ensureHeadersSent = () => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(200, responseHeaders);
    }
  };

  let finalPromptTokens = 0;
  let finalCompletionTokens = 0;
  let finalTotalTokens = 0;
  let finalCachedTokens = 0;
  let finalStreamChunks: string[] = [];
  let success = false;
  let lastEmptyError: ResponsesEmptyOutputError | null = null;

  attemptLoop: for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (abortSignal?.aborted) {
      const abortError = new Error('Request aborted');
      (abortError as any).name = 'AbortError';
      throw abortError;
    }

    const attemptStreamChunks: string[] = [];
    const pendingChunks: string[] = [];
    let buffering = true;
    let hasAssistantOutput = false;
    let bypassEmptyGuard = false;
    let responsesAggregate = createInitialAggregate();
    let bufferedOutputKeyUsed = false;

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;

    const writeChunk = async (data: string) => {
      attemptStreamChunks.push(data);
      ensureHeadersSent();
      if (!reply.raw.write(data)) {
        await new Promise<void>((resolve) => {
          reply.raw.once('drain', resolve);
        });
      }
    };

    const flushPendingChunks = async () => {
      if (!buffering) return;
      buffering = false;
      while (pendingChunks.length > 0) {
        const buffered = pendingChunks.shift()!;
        await writeChunk(buffered);
      }
    };

    const enqueueChunk = async (data: string) => {
      if (buffering) {
        pendingChunks.push(data);
      } else {
        await writeChunk(data);
      }
    };

    try {
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
        ensureHeadersSent();

        for await (const chunk of stream) {
          if (reply.raw.destroyed || reply.raw.writableEnded) {
            logger?.info('客户端已断开连接，停止流式传输', 'Protocol');
            break;
          }

          if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
            delete (chunk as any).instructions;
          }

          const previousLength = responsesAggregate.outputText.length;
          const updatedAggregate = processResponsesEvent(responsesAggregate, chunk as any);
          const producedText = updatedAggregate.outputText.length > previousLength;
          responsesAggregate = updatedAggregate;

          if (!hasAssistantOutput && (producedText || responsesEventHasAssistantContent(chunk))) {
            hasAssistantOutput = true;
            await flushPendingChunks();
          }

          if ((chunk as any)?.type === 'response.error' || (chunk as any)?.error) {
            bypassEmptyGuard = true;
            await flushPendingChunks();
          }

          if (placeholdersMap && restorePlaceholdersInObjectInPlace) {
            try {
              restorePlaceholdersInObjectInPlace(chunk, placeholdersMap);
            } catch {
              // Best-effort restoration.
            }

            if (
              streamRestorer &&
              typeof (chunk as any)?.delta?.text === 'string' &&
              String((chunk as any)?.type || '').includes('output_text.delta')
            ) {
              bufferedOutputKeyUsed = true;
              (chunk as any).delta.text = streamRestorer.process('responses:output_text', (chunk as any).delta.text);
            }
          } else if (remoteStreamRestorer) {
            if (
              typeof (chunk as any)?.delta?.text === 'string' &&
              String((chunk as any)?.type || '').includes('output_text.delta')
            ) {
              bufferedOutputKeyUsed = true;
              (chunk as any).delta.text = await remoteStreamRestorer.process(
                'responses:output_text',
                (chunk as any).delta.text,
                { flush: false }
              );
            }
          }

          const chunkData = JSON.stringify(chunk);
          const eventName = typeof (chunk as any)?.type === 'string' ? (chunk as any).type : undefined;
          const eventPrefix = eventName ? `event: ${eventName}\n` : '';
          const sseData = `${eventPrefix}data: ${chunkData}\n\n`;

          await enqueueChunk(sseData);

          const usageInChunk: any = (chunk?.usage ?? (chunk?.response && (chunk.response as any).usage) ?? null);
          if (usageInChunk) {
            const norm = normalizeUsageCounts(usageInChunk);
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

        if ((streamRestorer || remoteStreamRestorer) && bufferedOutputKeyUsed && !reply.raw.destroyed && !reply.raw.writableEnded) {
          const flushText = streamRestorer
            ? streamRestorer.flush('responses:output_text')
            : await remoteStreamRestorer!.flush('responses:output_text');
          if (flushText) {
            const flushEvent: any = {
              type: 'response.output_text.delta',
              delta: { text: flushText },
            };
            const flushData = `event: response.output_text.delta\n` + `data: ${JSON.stringify(flushEvent)}\n\n`;
            await enqueueChunk(flushData);
          }
        }
      } finally {
        if (abortSignal && abortHandler) {
          abortSignal.removeEventListener('abort', abortHandler as any);
        }
      }

      if (!hasAssistantOutput && !bypassEmptyGuard) {
        lastEmptyError = new ResponsesEmptyOutputError('Responses API stream completed without assistant output', {
          attempt,
          totalAttempts,
          status: responsesAggregate.status,
          lastEventType: responsesAggregate.lastEventType,
          responseId: responsesAggregate.id,
        });

        logger?.warn(
          `[Responses API] 未检测到 assistant 输出，准备重试 | attempt ${attempt}/${totalAttempts} | ` +
            `status=${responsesAggregate.status} | last_event=${responsesAggregate.lastEventType || 'unknown'}`,
          'Protocol'
        );

        continue attemptLoop;
      }

      finalPromptTokens = promptTokens;
      finalCompletionTokens = completionTokens;
      finalTotalTokens = totalTokens;
      finalCachedTokens = cachedTokens;
      finalStreamChunks = attemptStreamChunks;
      success = true;
      break;
    } catch (error: any) {
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        logger?.info('流式请求被用户取消', 'Protocol');
      }
      throw error;
    }
  }

  if (!success) {
    const errorToThrow =
      lastEmptyError ||
      new ResponsesEmptyOutputError('Responses API stream ended without assistant output', {
        totalAttempts,
      });

    logger?.error(`[Responses API] 多次尝试仍为空返回，终止请求 | attempts=${totalAttempts}`, 'Protocol');
    throw errorToThrow;
  }

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    ensureHeadersSent();
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }

  return {
    promptTokens: finalPromptTokens,
    completionTokens: finalCompletionTokens,
    totalTokens: finalTotalTokens,
    cachedTokens: finalCachedTokens,
    streamChunks: finalStreamChunks,
  };
}
