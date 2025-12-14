// Using global fetch (Node 18+)
import {
  buildChatCompletionsEndpoint,
  buildResponsesEndpoint,
  buildEndpointUrl,
  normalizeBaseUrl,
} from '../utils/api-endpoint-builder.js';
import { getBaseUrlForProtocol } from '../utils/protocol-utils.js';

type Protocol = 'openai' | 'anthropic' | 'google' | null | undefined;

export interface EndpointProbeResult {
  success: boolean;
  status?: number;
  message: string;
  responseTime: number;
  response?: {
    content: string;
    usage?: any;
  };
  error?: string;
}

export interface ModelProbeResult {
  chat: EndpointProbeResult;
  responses: EndpointProbeResult;
}

export interface HealthProbeOutcome {
  success: boolean;
  latencyMs: number;
  errorType?: string;
  errorMessage?: string;
  requestId?: string;
}

interface CommonRequestOptions {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

function startAbortTimer(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    clear: () => clearTimeout(timeoutId),
  };
}

// ---------- Body builders ----------

function buildChatBody(modelIdentifier: string, prompt: string) {
  return {
    model: modelIdentifier,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 200,
  };
}

function buildResponsesBody(modelIdentifier: string, prompt: string) {
  return {
    model: modelIdentifier,
    input: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

function buildAnthropicBody(modelIdentifier: string, prompt: string) {
  return {
    model: modelIdentifier,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  };
}

// ---------- Parsers ----------

function parseChatResponse(json: any): { content: string; usage?: any } {
  const content = json?.choices?.[0]?.message?.content ?? '';
  return { content: typeof content === 'string' ? content : String(content ?? '') || '无响应内容', usage: json?.usage };
}

function parseResponsesResponse(json: any): { content: string; usage?: any } {
  // Prefer output_text; fallback to nested shapes
  if (typeof json?.output_text === 'string') {
    return { content: json.output_text, usage: json?.usage };
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (typeof item?.text === 'string') {
        return { content: item.text, usage: json?.usage };
      }
      if (Array.isArray(item?.content)) {
        const block = item.content.find((b: any) => (b?.type === 'output_text' || b?.type === 'text') && typeof b?.text === 'string');
        if (block?.text) {
          return { content: block.text, usage: json?.usage };
        }
      }
    }
  }
  return { content: '无响应内容', usage: json?.usage };
}

function parseAnthropicResponse(json: any): { content: string; usage?: any } {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  if (blocks.length > 0) {
    const firstText = (blocks as any[]).find((b: any) => b?.type === 'text' && typeof b?.text === 'string');
    const text = firstText?.text ?? '';
    return { content: typeof text === 'string' && text.length > 0 ? text : '无响应内容', usage: json?.usage };
  }
  return { content: '无响应内容', usage: json?.usage };
}

// ---------- Low-level fetch helper ----------

async function doJsonRequest(url: string, opts: CommonRequestOptions): Promise<{ ok: boolean; status: number; json?: any; text?: string }> {
  const res = await fetch(url, opts as any);
  const status = res.status;
  const ok = res.ok;
  if (!ok) {
    const text = await res.text();
    return { ok, status, text };
  }
  const json = await res.json();
  return { ok, status, json };
}

// ---------- Public API: Probe via Provider (direct) ----------

/**
 * Probe a concrete model via its Provider baseUrl + apiKey.
 * Returns details for:
 * - chat (/chat/completions) for OpenAI/Google-like protocols
 * - responses (/responses) for OpenAI Responses API (skipped for Anthropic)
 * - anthropic uses /v1/messages and yields as 'chat' result; responses marked unsupported
 */
export async function probeModelViaProvider(args: {
  modelIdentifier: string;
  protocol: Protocol;
  provider: { base_url: string; protocol_mappings: string | null };
  apiKey: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<ModelProbeResult> {
  const { modelIdentifier, protocol, provider, apiKey } = args;
  const prompt = args.prompt ?? '测试';
  const timeoutMs = args.timeoutMs ?? 30000;

  const base = getBaseUrlForProtocol(provider as any, protocol || null);
  let baseUrl = normalizeBaseUrl(base);

  if (protocol === 'anthropic') {
    const url = baseUrl.endsWith('/v1')
      ? buildEndpointUrl(baseUrl, 'messages')
      : buildEndpointUrl(baseUrl, 'v1/messages');
    const started = Date.now();
    const { controller, clear } = startAbortTimer(timeoutMs);
    try {
      const res = await doJsonRequest(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildAnthropicBody(modelIdentifier, prompt)),
        signal: controller.signal,
      });
      const responseTime = Date.now() - started;
      if (!res.ok) {
        return {
          chat: {
            success: false,
            status: res.status,
            message: `Anthropic 测试失败: HTTP ${res.status}`,
            responseTime,
            error: res.text || '请求失败',
          },
          responses: {
            success: false,
            message: 'Anthropic 协议不支持 /responses 端点',
            responseTime: 0,
          },
        };
      }
      const parsed = parseAnthropicResponse(res.json);
      return {
        chat: {
          success: true,
          status: res.status,
          message: 'Anthropic 测试成功',
          responseTime,
          response: parsed,
        },
        responses: {
          success: false,
          message: 'Anthropic 协议不支持 /responses 端点',
          responseTime: 0,
        },
      };
    } catch (err: any) {
      const responseTime = Date.now() - started;
      return {
        chat: {
          success: false,
          message: `Anthropic 测试失败: ${err?.message || '请求失败'}`,
          responseTime,
          error: err?.stack || String(err),
        },
        responses: {
          success: false,
          message: 'Anthropic 协议不支持 /responses 端点',
          responseTime: 0,
        },
      };
    } finally {
      clear();
    }
  }

  // OpenAI/Google-like
  // Chat
  const chatUrl = buildChatCompletionsEndpoint(baseUrl);
  const chatStarted = Date.now();
  const chatTimer = startAbortTimer(timeoutMs);
  let chat: EndpointProbeResult;
  try {
    const res = await doJsonRequest(chatUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildChatBody(modelIdentifier, prompt)),
      signal: chatTimer.controller.signal,
    });
    const responseTime = Date.now() - chatStarted;
    if (!res.ok) {
      chat = {
        success: false,
        status: res.status,
        message: `Chat 测试失败: HTTP ${res.status}`,
        responseTime,
        error: res.text || '请求失败',
      };
    } else {
      const parsed = parseChatResponse(res.json);
      chat = {
        success: true,
        status: res.status,
        message: 'Chat 测试成功',
        responseTime,
        response: parsed,
      };
    }
  } catch (err: any) {
    const responseTime = Date.now() - chatStarted;
    chat = {
      success: false,
      message: `Chat 测试失败: ${err?.message || '请求失败'}`,
      responseTime,
      error: err?.stack || String(err),
    };
  } finally {
    chatTimer.clear();
  }

  // Responses
  const responsesUrl = buildResponsesEndpoint(baseUrl);
  const respStarted = Date.now();
  const respTimer = startAbortTimer(timeoutMs);
  let responses: EndpointProbeResult;
  try {
    const res = await doJsonRequest(responsesUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildResponsesBody(modelIdentifier, prompt)),
      signal: respTimer.controller.signal,
    });
    const responseTime = Date.now() - respStarted;
    if (!res.ok) {
      responses = {
        success: false,
        status: res.status,
        message: `Responses 测试失败: HTTP ${res.status}`,
        responseTime,
        error: res.text || '请求失败',
      };
    } else {
      const parsed = parseResponsesResponse(res.json);
      responses = {
        success: true,
        status: res.status,
        message: 'Responses 测试成功',
        responseTime,
        response: parsed,
      };
    }
  } catch (err: any) {
    const responseTime = Date.now() - respStarted;
    responses = {
      success: false,
      message: `Responses 测试失败: ${err?.message || '请求失败'}`,
      responseTime,
      error: err?.stack || String(err),
    };
  } finally {
    respTimer.clear();
  }

  return { chat, responses };
}

// ---------- Public API: Probe via Gateway (/v1 + Bearer VK) ----------

/**
 * Probe a model via Gateway base URL using a Virtual Key, for health checks.
 * - If endpoint is specified, use that endpoint directly
 * - Anthropic: POST /v1/messages
 * - OpenAI-like: try /v1/chat/completions then fallback /v1/responses; any success => healthy
 */
export async function probeModelViaGateway(args: {
  protocol: Protocol;
  modelName: string;        // The 'model' field expected by the Gateway (often model.name)
  gatewayUrl: string;       // Without /v1 suffix; we will append /v1
  bearerKey: string;        // Virtual key value
  prompt?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  endpoint?: string | null;  // Specific endpoint to check (e.g., '/v1/chat/completions', '/v1/messages')
}): Promise<HealthProbeOutcome> {
  const protocol = args.protocol ?? 'openai';
  const prompt = args.prompt ?? 'Say "OK"';
  const timeoutMs = args.timeoutMs ?? 20000;
  const v1 = normalizeBaseUrl(args.gatewayUrl) + '/v1';

  const started = Date.now();

  const commonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${args.bearerKey}`,
    'x-health-check': 'true',
    ...(args.extraHeaders || {}),
  };

  // If a specific endpoint is provided, use it directly
  if (args.endpoint) {
    const url = normalizeBaseUrl(args.gatewayUrl) + args.endpoint;

    // Determine the body format and parser based on the endpoint path
    let body: string;
    let parser: (json: any) => { content: string; usage?: any };

    if (args.endpoint.includes('/messages')) {
      body = JSON.stringify(buildAnthropicBody(args.modelName, prompt));
      parser = parseAnthropicResponse;
    } else if (args.endpoint.includes('/responses')) {
      body = JSON.stringify(buildResponsesBody(args.modelName, prompt));
      parser = parseResponsesResponse;
    } else {
      // Default to chat completions format
      body = JSON.stringify(buildChatBody(args.modelName, prompt));
      parser = parseChatResponse;
    }

    const timer = startAbortTimer(timeoutMs);
    try {
      const res = await doJsonRequest(url, {
        method: 'POST',
        headers: commonHeaders,
        body,
        signal: timer.controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const errText = res.text || `HTTP ${res.status}`;
        return {
          success: false,
          latencyMs,
          errorType: 'http_error',
          errorMessage: errText.substring(0, 200),
        };
      }
      const parsed = parser(res.json);
      if (!parsed.content || String(parsed.content).trim().length === 0) {
        return {
          success: false,
          latencyMs,
          errorType: 'empty_content',
          errorMessage: '响应内容为空',
        };
      }
      return { success: true, latencyMs };
    } catch (error: any) {
      const latencyMs = Date.now() - started;
      return mapTransportError(error, latencyMs, timeoutMs);
    } finally {
      timer.clear();
    }
  }

  // Legacy behavior: auto-detect endpoint based on protocol
  if (protocol === 'anthropic') {
    const url = buildEndpointUrl(v1, 'messages');
    const body = JSON.stringify(buildAnthropicBody(args.modelName, prompt));
    const timer = startAbortTimer(timeoutMs);
    try {
      const res = await doJsonRequest(url, {
        method: 'POST',
        headers: commonHeaders,
        body,
        signal: timer.controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const errText = res.text || `HTTP ${res.status}`;
        return {
          success: false,
          latencyMs,
          errorType: 'http_error',
          errorMessage: errText.substring(0, 200),
        };
      }
      const parsed = parseAnthropicResponse(res.json);
      if (!parsed.content || String(parsed.content).trim().length === 0) {
        return {
          success: false,
          latencyMs,
          errorType: 'empty_content',
          errorMessage: '响应内容为空',
        };
      }
      return { success: true, latencyMs };
    } catch (error: any) {
      const latencyMs = Date.now() - started;
      return mapTransportError(error, latencyMs, timeoutMs);
    } finally {
      timer.clear();
    }
  }

  // OpenAI-like: prefer /v1/chat/completions, then fall back to streaming /v1/responses
  let lastErrorType = 'unknown';
  let lastErrorMessage = '健康检查失败';

  {
    const chatUrl = buildChatCompletionsEndpoint(v1);
    const timer = startAbortTimer(timeoutMs);
    try {
      const res = await doJsonRequest(chatUrl, {
        method: 'POST',
        headers: commonHeaders,
        body: JSON.stringify(buildChatBody(args.modelName, prompt)),
        signal: timer.controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        lastErrorType = 'http_error';
        lastErrorMessage = (res.text || `HTTP ${res.status}`).substring(0, 200);
      } else {
        const content = parseChatResponse(res.json).content;
        if (typeof content === 'string' && content.trim().length > 0) {
          return { success: true, latencyMs };
        }
        lastErrorType = 'empty_content';
        lastErrorMessage = '响应内容为空';
      }
    } catch (error: any) {
      const latencyMs = Date.now() - started;
      const mapped = mapTransportError(error, latencyMs, timeoutMs);
      lastErrorType = mapped.errorType || 'unknown';
      lastErrorMessage = mapped.errorMessage || '请求失败';
    } finally {
      timer.clear();
    }
  }

  // 2) 回退到流式的 /responses（当前网关该端点仅支持流式）
  {
    const responsesUrl = buildResponsesEndpoint(v1);
    const timer = startAbortTimer(timeoutMs);
    try {
      const body = JSON.stringify({
        ...buildResponsesBody(args.modelName, prompt),
        stream: true,
      });

      const res = await fetch(responsesUrl, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Accept': 'text/event-stream',
        },
        body,
        signal: timer.controller.signal,
      } as any);

      const latencyMs = Date.now() - started;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErrorType = 'http_error';
        lastErrorMessage = (text || `HTTP ${res.status}`).substring(0, 200);
      } else {
        const ct = res.headers.get('content-type') || '';
        if (!ct.toLowerCase().includes('text/event-stream')) {
          lastErrorType = 'invalid_content_type';
          lastErrorMessage = `Unexpected Content-Type: ${ct}`.substring(0, 200);
        } else {
          // 对于健康检查而言，只要成功建立 SSE 连接即可认为健康
          return { success: true, latencyMs };
        }
      }
    } catch (error: any) {
      const latencyMs = Date.now() - started;
      const mapped = mapTransportError(error, latencyMs, timeoutMs);
      lastErrorType = mapped.errorType || 'unknown';
      lastErrorMessage = mapped.errorMessage || '请求失败';
    } finally {
      timer.clear();
    }
  }

  return {
    success: false,
    latencyMs: Date.now() - started,
    errorType: lastErrorType,
    errorMessage: lastErrorMessage,
  };
}

function mapTransportError(error: any, latencyMs: number, timeoutMs: number): HealthProbeOutcome {
  if (error?.name === 'AbortError') {
    return { success: false, latencyMs, errorType: 'timeout', errorMessage: `请求超时 (>${timeoutMs}ms)` };
  }
  if (error?.code === 'ECONNREFUSED') {
    return { success: false, latencyMs, errorType: 'connection_refused', errorMessage: '连接被拒绝' };
  }
  if (error?.code === 'ENOTFOUND') {
    return { success: false, latencyMs, errorType: 'dns_error', errorMessage: '无法解析主机名' };
  }
  return { success: false, latencyMs, errorType: 'unknown', errorMessage: error?.message || '请求失败' };
}

export const probeService = {
  probeModelViaProvider,
  probeModelViaGateway,
};
