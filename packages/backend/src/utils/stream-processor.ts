import type { FastifyReply } from 'fastify';

import { extractReasoningFromChoice } from './request-logger.js';
import { normalizeUsageCounts } from './usage-normalizer.js';

import type { ThinkingBlock, StreamTokenUsage } from '../routes/proxy/http-client.js';

type SyncStreamRestorer = {
  process: (key: string, content: string) => string;
  flush: (key: string) => string;
};

type AsyncStreamRestorer = {
  process: (key: string, content: string, options: { flush: boolean }) => Promise<string>;
  flush: (key: string) => Promise<string>;
};

export interface OpenAIChatStreamProcessorOptions {
  reply: FastifyReply;
  stream: AsyncIterable<any>;
  model: string;
  abortSignal?: AbortSignal;

  // Optional placeholder restoration hooks.
  placeholdersMap?: any;
  restorePlaceholdersInObjectInPlace?: (obj: any, placeholdersMap: any) => void;
  streamRestorer?: SyncStreamRestorer | null;
  remoteStreamRestorer?: AsyncStreamRestorer | null;

  logger?: {
    info: (msg: string, tag?: string) => void;
  };
}

export async function processOpenAIChatCompletionStreamToSse(
  options: OpenAIChatStreamProcessorOptions
): Promise<StreamTokenUsage> {
  const {
    reply,
    stream,
    model,
    abortSignal,
    placeholdersMap,
    restorePlaceholdersInObjectInPlace,
    streamRestorer,
    remoteStreamRestorer,
    logger,
  } = options;

  const bufferedKeys = new Set<string>();
  const finishedByChoiceIndex = new Set<number>();
  let lastChunkId: string | undefined;
  let lastChunkModel: string | undefined;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  const streamChunks: string[] = [];
  let reasoningContent = '';
  let thinkingBlocks: ThinkingBlock[] = [];
  let toolCalls: any[] = [];

  try {
    for await (const chunk of stream) {
      // Stop work if the downstream connection is gone.
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        logger?.info('客户端已断开连接，停止流式传输', 'Protocol');
        break;
      }

      if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
        delete (chunk as any).instructions;
      }

      if (placeholdersMap && restorePlaceholdersInObjectInPlace) {
        try {
          restorePlaceholdersInObjectInPlace(chunk, placeholdersMap);
        } catch {
          // Best-effort restoration.
        }

        if (Array.isArray((chunk as any).choices)) {
          for (const choice of (chunk as any).choices) {
            const idx = typeof choice?.index === 'number' ? choice.index : 0;
            const key = `chat:${idx}:content`;
            const content = choice?.delta?.content;

            if (streamRestorer && typeof content === 'string') {
              bufferedKeys.add(key);
              choice.delta.content = streamRestorer.process(key, content);
            } else if (remoteStreamRestorer && typeof content === 'string') {
              bufferedKeys.add(key);
              choice.delta.content = await remoteStreamRestorer.process(key, content, { flush: false });
            }

            // If upstream signals completion, flush any pending placeholder fragments into THIS chunk.
            if ((streamRestorer || remoteStreamRestorer) && choice?.finish_reason) {
              bufferedKeys.add(key);
              const flushText = streamRestorer
                ? streamRestorer.flush(key)
                : await remoteStreamRestorer!.flush(key);
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
      }

      if ((chunk as any)?.id) lastChunkId = String((chunk as any).id);
      if ((chunk as any)?.model) lastChunkModel = String((chunk as any).model);

      const chunkData = JSON.stringify(chunk);
      const sseData = `data: ${chunkData}\n\n`;
      streamChunks.push(sseData);

      if (!reply.raw.write(sseData)) {
        await new Promise<void>((resolve) => {
          reply.raw.once('drain', resolve);
        });
      }

      if ((chunk as any).usage) {
        const norm = normalizeUsageCounts((chunk as any).usage);
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
  } catch (error: any) {
    if (error.name === 'AbortError' || abortSignal?.aborted) {
      logger?.info('流式请求被用户取消', 'Protocol');
    }
    throw error;
  }

  // Flush placeholder tails that did not coincide with an upstream finish_reason.
  if ((streamRestorer || remoteStreamRestorer) && bufferedKeys.size > 0 && !reply.raw.destroyed && !reply.raw.writableEnded) {
    for (const key of bufferedKeys) {
      const flushText = streamRestorer ? streamRestorer.flush(key) : await remoteStreamRestorer!.flush(key);
      if (!flushText) continue;

      const match = key.match(/^chat:(\d+):content$/);
      const choiceIndex = match ? Number(match[1]) : 0;

      // Don't emit extra content after completion.
      if (finishedByChoiceIndex.has(choiceIndex)) {
        continue;
      }

      const flushChunk: any = {
        id: lastChunkId || `aifw_flush_${Date.now()}`,
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
      streamChunks.push(flushData);
      if (!reply.raw.write(flushData)) {
        await new Promise<void>((resolve) => {
          reply.raw.once('drain', resolve);
        });
      }
    }
  }

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    streamChunks,
    reasoningContent: reasoningContent || undefined,
    thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
  };
}
