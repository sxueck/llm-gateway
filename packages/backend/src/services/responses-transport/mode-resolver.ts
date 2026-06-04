/**
 * Resolve the effective transport mode from downstream + upstream transports.
 */

import type { ResponsesTransportMode } from './types.js';
import type { UpstreamTransport } from '../protocol-adapter.js';

export function resolveTransportMode(
  downstreamIsWebSocket: boolean,
  upstreamTransport: UpstreamTransport
): ResponsesTransportMode {
  if (downstreamIsWebSocket) {
    return upstreamTransport === 'websocket' ? 'ws_to_ws' : 'ws_to_http_sse';
  }
  return upstreamTransport === 'websocket' ? 'http_sse_to_ws' : 'http_sse_to_http_sse';
}
