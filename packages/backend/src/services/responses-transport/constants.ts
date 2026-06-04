/**
 * Responses Transport Matrix — constants and error codes
 */

/** Terminal event types that signal the end of a response stream. */
export const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'error',
  'response.error',
]);

/** WebSocket close codes used by the gateway. */
export const WS_CLOSE_CODES = {
  /** Normal closure — only used when the stream completed successfully. */
  NORMAL: 1000,
  /** Protocol error — used for invalid JSON, malformed frames, etc. */
  PROTOCOL_ERROR: 1002,
  /** Unsupported data — used for binary frames, unsupported events. */
  UNSUPPORTED_DATA: 1003,
  /** Policy violation — used for auth/config errors on the WebSocket. */
  POLICY_VIOLATION: 1008,
  /** Internal server error — used for upstream errors, handler crashes. */
  INTERNAL_ERROR: 1011,
} as const;

/** Stable machine-readable error codes emitted to downstream clients. */
export const ERROR_CODES = {
  /** Downstream sent a binary WebSocket frame. */
  BINARY_NOT_SUPPORTED: 'binary_not_supported',
  /** Downstream sent invalid JSON. */
  INVALID_JSON: 'invalid_json',
  /** Downstream sent an event type we do not recognise. */
  UNSUPPORTED_CLIENT_EVENT: 'unsupported_client_event',
  /** Downstream sent `response.create` while one is already in flight. */
  RESPONSE_IN_PROGRESS: 'response_in_progress',
  /** Downstream sent `response.cancel` but nothing was in flight. */
  NOTHING_TO_CANCEL: 'nothing_to_cancel',
  /** Upstream provider returned an error. */
  UPSTREAM_ERROR: 'upstream_error',
  /** The upstream stream closed before a terminal event. */
  UPSTREAM_STREAM_CLOSED: 'upstream_stream_closed',
  /** Request timed out waiting in queue or during streaming. */
  TIMEOUT: 'timeout',
  /** Max streaming duration exceeded. */
  MAX_DURATION: 'max_duration',
  /** Generic gateway handler error. */
  HANDLER_ERROR: 'handler_error',
  /** Bridge/stream error. */
  STREAM_ERROR: 'stream_error',
  /** Client disconnected before terminal event. */
  CLIENT_DISCONNECTED: 'client_disconnected',
  /** Idle timeout on WebSocket connection. */
  IDLE_TIMEOUT: 'idle_timeout',
  /** Provider configuration missing or invalid. */
  PROVIDER_CONFIG_ERROR: 'provider_config_error',
  /** Missing upstream URL or API key. */
  MISSING_UPSTREAM: 'missing_upstream',
} as const;

/** Error types used in the `error.type` field sent to clients. */
export const ERROR_TYPES = {
  GATEWAY_ERROR: 'gateway_error',
  RATE_LIMIT_ERROR: 'rate_limit_error',
  UPSTREAM_ERROR: 'upstream_error',
} as const;
