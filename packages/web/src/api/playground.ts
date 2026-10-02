import request from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import { SSEFrameParser } from '@/utils/sse';

export type PlaygroundProtocol = 'openai' | 'anthropic';

export interface PlaygroundUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export interface PlaygroundMetrics {
  durationMs: number;
  ttftMs: number | null;
  usage: PlaygroundUsage | null;
  model: string | null;
  requestId: string | null;
}

export interface PlaygroundChatRequest {
  virtualKeyId: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  extra?: Record<string, unknown>;
}

export interface PlaygroundAnthropicRequest {
  virtualKeyId: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface PlaygroundResult {
  ok: boolean;
  status: number;
  protocol: PlaygroundProtocol;
  durationMs: number;
  ttftMs: number | null;
  cost: number | null;
  metrics: PlaygroundMetrics;
  body: any;
}

export interface PlaygroundModelsResponse {
  virtualKeyId: string;
  models: Array<Record<string, unknown>>;
  error?: string;
}

/** 流式结束时后端追加的这一帧。 */
export interface PlaygroundStreamFrame {
  durationMs: number;
  ttftMs: number | null;
  cost: number | null;
  metrics: PlaygroundMetrics;
}

const BASE = '/admin/playground';

/**
 * 非流式走 fetch 而不是 request.ts 的 axios：后端在 4xx/5xx 时仍然回完整的
 * PlaygroundResult 信封（status + 上游错误 body），而 axios 拦截器会把它们压成
 * 一个只有 message 的 Error；另外 axios 全局 10s 超时会掩掉慢模型（后端上限 120s）。
 */
async function postJson(path: 'chat' | 'messages', payload: unknown): Promise<PlaygroundResult> {
  const authStore = useAuthStore();
  const response = await fetch(`/api${BASE}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authStore.token ? { authorization: `Bearer ${authStore.token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const envelope = (await response.json().catch(() => null)) as PlaygroundResult | null;
  if (envelope && typeof envelope.status === 'number' && 'metrics' in envelope) {
    return envelope;
  }
  // 网关层错误（无信封）：合成一个信封，保证指标卡永远有状态码。
  return {
    ok: false,
    status: response.status,
    protocol: path === 'chat' ? 'openai' : 'anthropic',
    durationMs: 0,
    ttftMs: null,
    cost: null,
    metrics: {
      durationMs: 0,
      ttftMs: null,
      usage: null,
      model: null,
      requestId: null,
    },
    body: envelope ?? {
      error: { message: `HTTP ${response.status} ${response.statusText}` },
    },
  };
}

export const playgroundApi = {
  chat(payload: PlaygroundChatRequest): Promise<PlaygroundResult> {
    return postJson('chat', payload);
  },

  messages(payload: PlaygroundAnthropicRequest): Promise<PlaygroundResult> {
    return postJson('messages', payload);
  },

  getModels(virtualKeyId: string): Promise<PlaygroundModelsResponse> {
    return request.get(`${BASE}/models`, { params: { virtualKeyId } });
  },
};

export interface StreamHandlers {
  /** 上游每一帧的原始文本（已按 SSE 块切分），交给调用方解析增量内容。 */
  onChunk: (data: string) => void;
  onMetrics: (frame: PlaygroundStreamFrame) => void;
  signal?: AbortSignal;
}

/**
 * 流式调用：axios 无法读 SSE，这里用 fetch + JWT（与 utils/sse.ts 同一约束）。
 * `event: playground` 帧是后端注入的计量信息，不作为内容交给 onChunk。
 */
export async function streamPlayground(
  path: 'chat' | 'messages',
  payload: PlaygroundChatRequest | PlaygroundAnthropicRequest,
  handlers: StreamHandlers,
): Promise<void> {
  const authStore = useAuthStore();
  const response = await fetch(`/api${BASE}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(authStore.token ? { authorization: `Bearer ${authStore.token}` } : {}),
    },
    body: JSON.stringify({ ...payload, stream: true }),
    signal: handlers.signal,
  });

  if (!response.ok || !response.body) {
    // 上游/校验失败时后端回的是普通 JSON 错误信封。
    let message = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      message = json?.error?.message || json?.body?.error?.message || message;
    } catch {
      /* 非 JSON 响应，保留状态码 */
    }
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEFrameParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      if (frame.event === 'playground') {
        try {
          handlers.onMetrics(JSON.parse(frame.data) as PlaygroundStreamFrame);
        } catch {
          /* 计量帧损坏时忽略，内容已经流完 */
        }
      } else if (frame.data) {
        handlers.onChunk(frame.data);
      }
    }
  }
}
