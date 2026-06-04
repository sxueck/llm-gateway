/**
 * Responses Transport Matrix — validation and helper functions
 */

import {
  TERMINAL_EVENT_TYPES,
  ERROR_CODES,
  ERROR_TYPES,
  WS_CLOSE_CODES,
} from './constants.js';
import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
  NormalizedResponsesRequest,
  ResponsesServerEventError,
} from './types.js';

/** Returns true if the given server event type is terminal. */
export function isTerminalEventType(type: string | undefined): boolean {
  if (!type) return false;
  return TERMINAL_EVENT_TYPES.has(type);
}

/** Returns true if the event object itself represents a terminal condition. */
export function isTerminalEvent(event: ResponsesServerEvent | undefined): boolean {
  if (!event) return false;
  return isTerminalEventType(event.type);
}

/** Build a standardised gateway error event. */
export function buildErrorEvent(
  message: string,
  code: string,
  type: string = ERROR_TYPES.GATEWAY_ERROR,
  param: string | null = null
): ResponsesServerEventError {
  return {
    type: 'error',
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

/** Normalise a downstream `response.create` payload.
 *  OpenAI Responses WebSocket events wrap the body under `.response`;
 *  HTTP POST bodies send the params directly. */
export function normalizeResponseCreate(requestBody: any): NormalizedResponsesRequest {
  const body =
    requestBody?.type === 'response.create' &&
    requestBody?.response &&
    typeof requestBody.response === 'object'
      ? { ...requestBody.response }
      : { ...requestBody };

  // Remove the synthetic `type` field if it leaked into the body
  delete body.type;

  return {
    body,
    conversationId: requestBody?.conversationId,
    sessionId: requestBody?.sessionId,
    stream: body?.stream !== false,
  };
}

/** Validate and extract a client event from a downstream WebSocket message.
 *  Throws with `.code` set to one of the `ERROR_CODES` constants on failure. */
export function parseClientWebSocketEvent(data: any, isBinary: boolean): ResponsesClientEvent {
  if (isBinary) {
    const err = new Error('Binary frames are not supported');
    (err as any).code = ERROR_CODES.BINARY_NOT_SUPPORTED;
    (err as any).wsCloseCode = WS_CLOSE_CODES.UNSUPPORTED_DATA;
    throw err;
  }

  let text: string;
  if (Buffer.isBuffer(data)) {
    text = data.toString('utf-8');
  } else if (typeof data === 'string') {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf-8');
  } else if (Array.isArray(data)) {
    text = Buffer.concat(data as any).toString('utf-8');
  } else {
    text = String(data);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON');
    (err as any).code = ERROR_CODES.INVALID_JSON;
    (err as any).wsCloseCode = WS_CLOSE_CODES.PROTOCOL_ERROR;
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    const err = new Error('Missing event type');
    (err as any).code = ERROR_CODES.UNSUPPORTED_CLIENT_EVENT;
    (err as any).wsCloseCode = WS_CLOSE_CODES.PROTOCOL_ERROR;
    throw err;
  }

  if (parsed.type === 'response.create' || parsed.type === 'response.cancel') {
    return parsed as ResponsesClientEvent;
  }

  const err = new Error(`Unsupported client event type: ${parsed.type}`);
  (err as any).code = ERROR_CODES.UNSUPPORTED_CLIENT_EVENT;
  (err as any).wsCloseCode = WS_CLOSE_CODES.PROTOCOL_ERROR;
  throw err;
}

/** Build a queue-429 error payload compatible with OpenAI error shape. */
export function buildQueueError(
  reason: 'queue_full' | 'timeout' | 'cancelled'
): ResponsesServerEventError {
  const message =
    reason === 'queue_full'
      ? 'Request queue is full for this virtual key. Please try again later.'
      : reason === 'timeout'
      ? 'Request timed out waiting in queue. Please try again later.'
      : 'Request was cancelled while waiting in queue.';

  return {
    type: 'error',
    error: {
      message,
      type: ERROR_TYPES.RATE_LIMIT_ERROR,
      param: null,
      code: `queue_${reason}`,
    },
  };
}

/** Convert a parsed SSE event line into a `ResponsesServerEvent`.
 *  Returns `undefined` for `[DONE]` markers or unparseable lines. */
export function parseSseEventLine(line: string): ResponsesServerEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as ResponsesServerEvent;
    }
  } catch {
    // ignore malformed JSON
  }
  return undefined;
}

/** Convert a `ResponsesServerEvent` into an SSE frame string. */
export function serverEventToSseFrame(event: ResponsesServerEvent): string {
  const eventName = event.type;
  const data = JSON.stringify(event);
  return `event: ${eventName}\ndata: ${data}\n\n`;
}

/** Convert a `ResponsesServerEvent` into a WebSocket JSON text frame string. */
export function serverEventToWsFrame(event: ResponsesServerEvent): string {
  return JSON.stringify(event);
}
