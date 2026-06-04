/**
 * Downstream WebSocket writer.
 *
 * Consumes an async iterable of `ResponsesServerEvent` and sends
 * each event as a JSON text frame over a WebSocket.
 */

import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import type { ResponsesServerEvent, ResponsesStreamResult } from './types.js';
import { serverEventToWsFrame } from './helpers.js';
import { isTerminalEvent } from './helpers.js';
import { WS_CLOSE_CODES } from './constants.js';

export interface DownstreamWsWriterOptions {
  socket: WsWebSocket;
  /** Close the socket with NORMAL (1000) after a terminal event.
   *  Default: false (keep connection open for follow-up requests). */
  closeOnTerminal?: boolean;
  logPrefix?: string;
}

export async function writeEventsToWebSocket(
  events: AsyncIterable<ResponsesServerEvent>,
  options: DownstreamWsWriterOptions
): Promise<ResponsesStreamResult> {
  const { socket, closeOnTerminal = false } = options;
  const { WebSocket } = await import('ws');

  let result: ResponsesStreamResult | undefined;
  let terminalEventReceived = false;
  let terminalEventType: string | undefined;

  for await (const event of events) {
    if (socket.readyState !== WebSocket.OPEN) {
      break;
    }

    // Capture internal metadata without sending it to the client.
    if ((event as any).__result) {
      result = (event as any).__result as ResponsesStreamResult;
      continue;
    }

    try {
      socket.send(serverEventToWsFrame(event));
    } catch (err: any) {
      throw new Error(`Failed to send WS frame: ${err.message}`);
    }

    if (isTerminalEvent(event)) {
      terminalEventReceived = true;
      terminalEventType = event.type;
      if (closeOnTerminal) {
        socket.close(WS_CLOSE_CODES.NORMAL, 'stream_complete');
      }
      // Do NOT break here: the orchestrator yields a __stream_result sentinel
      // immediately after the terminal event. We must consume it to capture
      // token usage and transport mode metadata.
    }
  }

  if (result) {
    return result;
  }

  return {
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    terminalEventReceived,
    terminalEventType,
    transportMode: 'ws_to_http_sse',
  };
}
