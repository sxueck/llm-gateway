import OpenAI from 'openai';
import { assignResponsesRequestParams, type ProtocolConfig } from '../protocol-adapter.js';
import type {
  ResponsesServerEvent,
  NormalizedResponsesRequest,
  ResponsesStreamResult,
} from '../responses-transport/types.js';
import { HttpClientFactory } from '../http-client-factory.js';
import { filterForwardedHeaders } from '../../utils/header-sanitizer.js';
import { memoryLogger } from '../logger.js';
import { isTerminalEvent } from '../responses-transport/helpers.js';
import { normalizeUsageCounts } from '../../utils/usage-normalizer.js';

function getOpenAIClient(config: ProtocolConfig): OpenAI {
  const factory = new HttpClientFactory({
    keepAliveMaxSockets: parseInt(process.env.HTTP_KEEP_ALIVE_MAX_SOCKETS || '64', 10),
    logger: memoryLogger as any,
  });
  return factory.getOpenAIClient(config);
}

function buildRequestParams(config: ProtocolConfig, request: NormalizedResponsesRequest): any {
  const body = request.body;
  const params: any = {
    model: config.model,
    input: body.input ?? '',
    stream: true,
  };

  assignResponsesRequestParams(params, body, true);
  return params;
}

function buildRequestOptions(
  config: ProtocolConfig,
  request: NormalizedResponsesRequest,
  abortSignal: AbortSignal
): any {
  const options: any = {};

  const requestTimeoutMs =
    config.modelAttributes?.requestTimeout !== undefined
      ? config.modelAttributes.requestTimeout
      : undefined;
  if (requestTimeoutMs !== undefined) {
    options.timeout = requestTimeoutMs;
  }

  const extraHeaders: Record<string, string> = {};
  if (request.conversationId) {
    extraHeaders['Conversation-Id'] = request.conversationId;
  }
  if (request.sessionId) {
    extraHeaders['Session-Id'] = request.sessionId;
  }

  const forwardedHeaders = filterForwardedHeaders(
    config.modelAttributes?.headers,
    (request.body as any)?.__forwardedHeaders
  );
  if (forwardedHeaders) {
    Object.assign(extraHeaders, forwardedHeaders);
  }

  if (Object.keys(extraHeaders).length > 0) {
    options.headers = extraHeaders;
  }

  options.signal = abortSignal;
  return options;
}

export async function* streamUpstreamSse(
  config: ProtocolConfig,
  request: NormalizedResponsesRequest,
  abortSignal: AbortSignal
): AsyncGenerator<ResponsesServerEvent, ResponsesStreamResult, unknown> {
  const client = getOpenAIClient(config);
  const requestParams = buildRequestParams(config, request);
  const requestOptions = buildRequestOptions(config, request, abortSignal);

  const startedAt = Date.now();
  let tffbMs: number | undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let terminalEventReceived = false;
  let terminalEventType: string | undefined;

  const stream = (await client.responses.create(
    requestParams,
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined
  )) as unknown as AsyncIterable<any>;

  for await (const chunk of stream) {
    if (abortSignal.aborted) {
      break;
    }

    if (tffbMs === undefined) {
      tffbMs = Date.now() - startedAt;
    }

    if (chunk && typeof chunk === 'object' && 'instructions' in chunk) {
      delete (chunk as any).instructions;
    }

    const event = chunk as ResponsesServerEvent;
    yield event;

    if (isTerminalEvent(event)) {
      terminalEventReceived = true;
      terminalEventType = event.type;
    }

    const usage =
      (chunk as any)?.usage ?? (chunk as any)?.response?.usage;
    if (usage) {
      const norm = normalizeUsageCounts(usage);
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

  return {
    tokenUsage: { promptTokens, completionTokens, totalTokens, cachedTokens },
    tffbMs,
    terminalEventReceived,
    terminalEventType,
    // transportMode is overridden by the orchestrator based on the full matrix
    transportMode: 'http_sse_to_http_sse',
  };
}
