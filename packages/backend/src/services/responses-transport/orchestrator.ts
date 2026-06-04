import type { ProtocolConfig } from '../protocol-adapter.js';
import type {
  ResponsesTransportMode,
  ResponsesServerEvent,
  NormalizedResponsesRequest,
  ResponsesStreamResult,
} from './types.js';
import { streamUpstreamSse } from './upstream-sse-adapter.js';
import { streamUpstreamWebSocket } from './upstream-ws-adapter.js';
import { isTerminalEvent } from './helpers.js';

const SENTINEL_RESULT_TYPE = '__stream_result';

function makeResultEvent(result: ResponsesStreamResult): ResponsesServerEvent {
  return {
    type: SENTINEL_RESULT_TYPE,
    __result: result,
  } as any;
}

export async function* runResponsesTransport(
  mode: ResponsesTransportMode,
  config: ProtocolConfig,
  request: NormalizedResponsesRequest,
  abortSignal: AbortSignal
): AsyncGenerator<ResponsesServerEvent, ResponsesStreamResult, unknown> {
  let upstreamGenerator: AsyncGenerator<ResponsesServerEvent, ResponsesStreamResult, unknown>;

  switch (mode) {
    case 'http_sse_to_http_sse':
    case 'ws_to_http_sse':
      upstreamGenerator = streamUpstreamSse(config, request, abortSignal);
      break;
    case 'http_sse_to_ws':
    case 'ws_to_ws':
      upstreamGenerator = streamUpstreamWebSocket(config, request, abortSignal);
      break;
    default:
      throw new Error(`Unknown transport mode: ${mode}`);
  }

  let terminalEventReceived = false;
  let terminalEventType: string | undefined;

  try {
    while (true) {
      const next = await upstreamGenerator.next();

      if (next.done) {
        const result: ResponsesStreamResult = {
          ...next.value,
          transportMode: mode,
          terminalEventReceived: terminalEventReceived || next.value.terminalEventReceived,
          terminalEventType: terminalEventType || next.value.terminalEventType,
        };
        yield makeResultEvent(result);
        return result;
      }

      const event = next.value;
      yield event;

      if (isTerminalEvent(event)) {
        terminalEventReceived = true;
        terminalEventType = event.type;
      }
    }
  } finally {
    // Ensure upstream generator is cleaned up if the consumer breaks early
    if (!upstreamGenerator.return) {
      return {
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
        terminalEventReceived,
        terminalEventType,
        transportMode: mode,
      };
    }
    try {
      await upstreamGenerator.return({
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
        terminalEventReceived,
        terminalEventType,
        transportMode: mode,
      });
    } catch (_e) {
      // ignore cleanup errors
    }
  }
}
