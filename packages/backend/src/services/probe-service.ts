import {
  buildChatCompletionsEndpoint,
  buildResponsesEndpoint,
  buildEndpointUrl,
  normalizeBaseUrl,
} from '../utils/api-endpoint-builder.js';
import { getBaseUrlForProtocol } from '../utils/protocol-utils.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';

type Protocol = 'openai' | 'anthropic' | 'google' | null | undefined;

interface ParsedProbeResponse {
  content: string;
  usage?: any;
  conversation_id?: string;
  session_id?: string;
}

export interface EndpointProbeResult {
  success: boolean;
  status?: number;
  message: string;
  responseTime: number;
  response?: ParsedProbeResponse;
  error?: string;
}

export interface ModelProbeResult {
  chat: EndpointProbeResult;
  responses: EndpointProbeResult;
}

interface CommonRequestOptions {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

function extractSessionInfo(json: any): { conversation_id?: string; session_id?: string } {
  const pick = (candidates: any[]): string | undefined => {
    for (const value of candidates) {
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  };

  const conversation_id = pick([
    json?.conversation_id,
    json?.conversationId,
    json?.conversation?.id,
    json?.response?.conversation_id,
    json?.response?.conversationId,
    json?.response?.conversation?.id,
  ]);

  const session_id = pick([
    json?.session_id,
    json?.sessionId,
    json?.session?.id,
    json?.response?.session_id,
    json?.response?.sessionId,
    json?.response?.session?.id,
  ]);

  return {
    conversation_id,
    session_id,
  };
}

function startAbortTimer(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    clear: () => clearTimeout(timeoutId),
  };
}

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

function buildGeminiNativeBody(prompt: string) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 200,
    },
  };
}

function parseChatResponse(json: any): ParsedProbeResponse {
  const content = json?.choices?.[0]?.message?.content ?? '';
  const sessionInfo = extractSessionInfo(json);
  return {
    content: typeof content === 'string' ? content : String(content ?? '') || '无响应内容',
    usage: json?.usage,
    ...sessionInfo,
  };
}

function parseResponsesResponse(json: any): ParsedProbeResponse {
  // Prefer output_text; fallback to nested shapes
  if (typeof json?.output_text === 'string') {
    return { content: json.output_text, usage: json?.usage, ...extractSessionInfo(json) };
  }
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (typeof item?.text === 'string') {
        return { content: item.text, usage: json?.usage, ...extractSessionInfo(json) };
      }
      if (Array.isArray(item?.content)) {
        const block = item.content.find((b: any) => (b?.type === 'output_text' || b?.type === 'text') && typeof b?.text === 'string');
        if (block?.text) {
          return { content: block.text, usage: json?.usage, ...extractSessionInfo(json) };
        }
      }
    }
  }
  return { content: '无响应内容', usage: json?.usage, ...extractSessionInfo(json) };
}

function parseAnthropicResponse(json: any): ParsedProbeResponse {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  if (blocks.length > 0) {
    const firstText = (blocks as any[]).find((b: any) => b?.type === 'text' && typeof b?.text === 'string');
    const text = firstText?.text ?? '';
    return {
      content: typeof text === 'string' && text.length > 0 ? text : '无响应内容',
      usage: json?.usage,
      ...extractSessionInfo(json),
    };
  }
  return { content: '无响应内容', usage: json?.usage, ...extractSessionInfo(json) };
}

function parseGeminiNativeResponse(json: any): ParsedProbeResponse {
  // Gemini 响应格式: { candidates: [{ content: { parts: [{ text: "..." }] } }], usageMetadata: {...} }
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  if (candidates.length > 0) {
    const firstCandidate = candidates[0];
    const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
    if (parts.length > 0) {
      const firstPart = parts[0];
      const text = firstPart?.text ?? '';
      return {
        content: typeof text === 'string' && text.length > 0 ? text : '无响应内容',
        usage: json?.usageMetadata,
        ...extractSessionInfo(json),
      };
    }
  }
  return { content: '无响应内容', usage: json?.usageMetadata, ...extractSessionInfo(json) };
}

async function doJsonRequest(url: string, opts: CommonRequestOptions): Promise<{ ok: boolean; status: number; json?: any; text?: string }> {
  const res = await upstreamFetch(url, {
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    signal: opts.signal,
  });
  const status = res.status;
  const ok = res.ok;

  try {
    if (!ok) {
      const text = await res.text();
      return { ok, status, text };
    }
    const json = await res.json();
    return { ok, status, json };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('terminated: 响应读取被中止');
    }
    throw new Error(`响应解析失败: ${error.message}`);
  }
}

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

  if (protocol === 'google') {
    const url = buildEndpointUrl(baseUrl, `v1beta/models/${modelIdentifier}:generateContent`);
    const started = Date.now();
    const { controller, clear } = startAbortTimer(timeoutMs);
    try {
      const res = await doJsonRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(buildGeminiNativeBody(prompt)),
        signal: controller.signal,
      });
      const responseTime = Date.now() - started;
      if (!res.ok) {
        const chat: EndpointProbeResult = {
          success: false,
          status: res.status,
          message: `Gemini 测试失败: HTTP ${res.status}`,
          responseTime,
          error: res.text || '请求失败',
        };
        // 对于 Gemini 原生协议，只对原生接口进行一次检查，responses 结果与 chat 保持一致
        return {
          chat,
          responses: chat,
        };
      }
      const parsed = parseGeminiNativeResponse(res.json);
      const chat: EndpointProbeResult = {
        success: true,
        status: res.status,
        message: 'Gemini 测试成功',
        responseTime,
        response: parsed,
      };
      // 仅进行一次原生接口检查，前端会对 Google 协议隐藏 Responses API 相关展示
      return {
        chat,
        responses: chat,
      };
    } catch (err: any) {
      const responseTime = Date.now() - started;
      const chat: EndpointProbeResult = {
        success: false,
        message: `Gemini 测试失败: ${err?.message || '请求失败'}`,
        responseTime,
        error: err?.stack || String(err),
      };
      return {
        chat,
        responses: chat,
      };
    } finally {
      clear();
    }
  }

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

export const probeService = {
  probeModelViaProvider,
};
