/**
 * Downstream SSE writer.
 *
 * Consumes an async iterable of `ResponsesServerEvent` and writes
 * `event:` / `data:` frames to a Fastify reply.
 */

import type { FastifyReply } from 'fastify';
import type { ResponsesServerEvent, ResponsesStreamResult } from './types.js';
import { serverEventToSseFrame } from './helpers.js';

export interface DownstreamSseWriterOptions {
  reply: FastifyReply;
  responseHeaders?: Record<string, string>;
}

export async function writeEventsToSse(
  events: AsyncIterable<ResponsesServerEvent>,
  options: DownstreamSseWriterOptions
): Promise<ResponsesStreamResult> {
  const { reply, responseHeaders } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    ...responseHeaders,
  };

  if (!reply.raw.headersSent) {
    reply.raw.writeHead(200, headers);
  }

  let result: ResponsesStreamResult | undefined;

  for await (const event of events) {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      break;
    }

    // Skip internal metadata sentinel; it must not leak to the client.
    if ((event as any).__result) {
      result = (event as any).__result as ResponsesStreamResult;
      continue;
    }

    const frame = serverEventToSseFrame(event);

    if (!reply.raw.write(frame)) {
      await new Promise<void>((resolve) => {
        reply.raw.once('drain', resolve);
      });
    }
  }

  if (!reply.raw.destroyed && !reply.raw.writableEnded) {
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  }

  if (result) {
    return result;
  }

  // Fallback result if the orchestrator didn't inject metadata
  return {
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    terminalEventReceived: false,
    transportMode: 'http_sse_to_http_sse',
  };
}
