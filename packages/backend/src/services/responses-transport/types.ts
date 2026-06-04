/**
 * Responses Transport Matrix — internal contracts
 *
 * These types are the shared boundary between downstream readers/writers
 * (HTTP SSE, WebSocket) and upstream adapters (HTTP SSE, WebSocket).
 */

export type ResponsesTransportMode =
  | 'http_sse_to_http_sse'
  | 'http_sse_to_ws'
  | 'ws_to_http_sse'
  | 'ws_to_ws';

// ---------------------------------------------------------------------------
// Client → Gateway (downstream)
// ---------------------------------------------------------------------------

export interface ResponsesClientEventResponseCreate {
  type: 'response.create';
  response?: Record<string, any>;
  [key: string]: any;
}

export interface ResponsesClientEventResponseCancel {
  type: 'response.cancel';
  [key: string]: any;
}

export type ResponsesClientEvent =
  | ResponsesClientEventResponseCreate
  | ResponsesClientEventResponseCancel;

// ---------------------------------------------------------------------------
// Gateway → Client (downstream)
// ---------------------------------------------------------------------------

export interface ResponsesServerEventBase {
  type: string;
  [key: string]: any;
}

export interface ResponsesServerEventOutputTextDelta extends ResponsesServerEventBase {
  type: 'response.output_text.delta';
  delta: { text: string };
}

export interface ResponsesServerEventOutputItemDone extends ResponsesServerEventBase {
  type: 'response.output_item.done';
  item?: any;
}

export interface ResponsesServerEventCompleted extends ResponsesServerEventBase {
  type: 'response.completed';
  response?: any;
}

export interface ResponsesServerEventFailed extends ResponsesServerEventBase {
  type: 'response.failed';
  response?: any;
}

export interface ResponsesServerEventIncomplete extends ResponsesServerEventBase {
  type: 'response.incomplete';
  response?: any;
}

export interface ResponsesServerEventCancelled extends ResponsesServerEventBase {
  type: 'response.cancelled';
  response?: any;
}

export interface ResponsesServerEventError extends ResponsesServerEventBase {
  type: 'error';
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

export type ResponsesServerEvent =
  | ResponsesServerEventOutputTextDelta
  | ResponsesServerEventOutputItemDone
  | ResponsesServerEventCompleted
  | ResponsesServerEventFailed
  | ResponsesServerEventIncomplete
  | ResponsesServerEventCancelled
  | ResponsesServerEventError
  | ResponsesServerEventBase;

// ---------------------------------------------------------------------------
// Normalised request (after parsing any downstream transport)
// ---------------------------------------------------------------------------

export interface NormalizedResponsesRequest {
  /** The original client payload, normalised so that `response.create` events
   *  are flattened to their `.response` body when present. */
  body: Record<string, any>;

  /** Conversation/session identifiers carried from the downstream request. */
  conversationId?: string;
  sessionId?: string;

  /** Whether the downstream explicitly asked for streaming. */
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// Stream bridge result
// ---------------------------------------------------------------------------

export interface ResponsesStreamResult {
  /** Token usage aggregated across the full stream. */
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
  };

  /** Time-to-first-byte (first upstream event) in milliseconds, if known. */
  tffbMs?: number;

  /** Whether the stream ended with a recognised terminal event. */
  terminalEventReceived: boolean;

  /** The terminal event type, if one was received. */
  terminalEventType?: string;

  /** Transport mode actually exercised. */
  transportMode: ResponsesTransportMode;
}

/** Core abstraction: turn a normalised request into an async iterable of
 *  server events, honouring the supplied abort signal. */
export type ResponsesStreamBridge = (
  request: NormalizedResponsesRequest,
  signal: AbortSignal
) => AsyncIterable<ResponsesServerEvent>;

/** Extended bridge that also yields final metadata once the stream ends.
 *  Consumers should iterate events until `done`, then read `value` for the
 *  `ResponsesStreamResult`. */
export type ResponsesStreamBridgeWithResult = (
  request: NormalizedResponsesRequest,
  signal: AbortSignal
) => AsyncGenerator<ResponsesServerEvent, ResponsesStreamResult, unknown>;
