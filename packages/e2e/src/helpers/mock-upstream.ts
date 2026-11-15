import http from "node:http";
import type { AddressInfo } from "node:net";
import { MOCK_UPSTREAM_KEY } from "./env.js";

export type UpstreamKind = "openai" | "anthropic" | "gemini" | "jev";

/**
 * 故障注入命中该请求时记入 journal 的补充字段；正常请求没有该字段。
 * wire 说明失败是以什么方式落到线上的（这是测试能依赖的事实）：
 * - socket-destroyed   传输层 RST 中断：线上没有任何 HTTP/SSE 错误语义，客户端只见连接断开
 * - sse-error-then-end 响应状态行已提交为 200，错误语义只能以带内 SSE error 事件传达后干净收尾
 * - http-status        响应头尚未提交，注入的状态码（和 Retry-After 头）原样落到线上
 */
export type UpstreamFailureWire = "socket-destroyed" | "sse-error-then-end" | "http-status";

export interface UpstreamFailureRecord {
  mode: "drop-after-chunks" | "mid-stream-status";
  /** 注入触发前已写出的 SSE 事件帧数（含 [DONE] 这类终止帧） */
  chunksWritten: number;
  wire: UpstreamFailureWire;
  /** mid-stream-status 的语义状态码。流式路径上它不会出现在状态行（见 wire），仅供断言区分意图与线上行为 */
  status?: number;
  /** mid-stream-status 的可选退避秒数；流式路径上只能并入事件负载，非流式路径才是真实 HTTP 头 */
  retryAfterSeconds?: number | null;
}

export interface JournalEntry {
  kind: UpstreamKind;
  path: string;
  authorization: string | null;
  /** Anthropic 原生转发使用的头 */
  xApiKey: string | null;
  /** Gemini 原生转发使用的头 */
  xGoogApiKey: string | null;
  body: unknown;
  at: number;
  failure?: UpstreamFailureRecord;
}

/** 已武装的故障注入规格。 */
export type UpstreamFailModeSpec =
  | { mode: "drop-after-chunks"; chunks: number }
  | { mode: "mid-stream-status"; status: number; retryAfterSeconds: number | null };

/** GET /_internal/upstream-fail-mode 的当前状态视图。fired 表示 one-shot 是否已被某请求消耗。 */
export interface UpstreamFailModeView {
  spec: UpstreamFailModeSpec | null;
  fired: boolean;
}

const DROP_AFTER_CHUNKS_RE = /^drop-after-chunks:(0|[1-9]\d*)$/;
const MID_STREAM_STATUS_RE = /^mid-stream-status:(\d{3})$/;

/**
 * 解析 /_internal/upstream-fail-mode 的 mode 参数。
 * - null / undefined / ""  → 清除注入（spec: null）
 * - "drop-after-chunks:N"  → N 为非负整数，只对流式（SSE）请求生效
 * - "mid-stream-status:S"  → S 为 400..599；流式请求走带内错误事件，非流式请求返回真实 S 状态码
 * retryAfterSeconds 仅对 mid-stream-status 有意义（非负整秒）。
 */
export function parseUpstreamFailMode(
  mode: unknown,
  retryAfterSeconds: unknown,
): { ok: true; spec: UpstreamFailModeSpec | null } | { ok: false; error: string } {
  if (mode === null || mode === undefined || mode === "") return { ok: true, spec: null };
  if (typeof mode !== "string") return { ok: false, error: "mode must be a string or null" };

  let retryAfter: number | null = null;
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null) {
    if (
      typeof retryAfterSeconds !== "number" ||
      !Number.isInteger(retryAfterSeconds) ||
      retryAfterSeconds < 0
    ) {
      return { ok: false, error: "retryAfterSeconds must be a non-negative integer (seconds)" };
    }
    retryAfter = retryAfterSeconds;
  }

  const drop = mode.match(DROP_AFTER_CHUNKS_RE);
  if (drop) {
    if (retryAfter !== null) {
      return { ok: false, error: "retryAfterSeconds is only valid with mid-stream-status" };
    }
    return { ok: true, spec: { mode: "drop-after-chunks", chunks: Number(drop[1]) } };
  }

  const mid = mode.match(MID_STREAM_STATUS_RE);
  if (mid) {
    const status = Number(mid[1]);
    if (status < 400 || status > 599) {
      return { ok: false, error: `mid-stream-status must be an error status (400-599), got ${status}` };
    }
    return { ok: true, spec: { mode: "mid-stream-status", status, retryAfterSeconds: retryAfter } };
  }

  return {
    ok: false,
    error: `unknown fail mode "${mode}"; expected "drop-after-chunks:N" or "mid-stream-status:<400-599>"`,
  };
}

interface SemanticErrorShape {
  message: string;
  openaiType: string;
  openaiCode: string | null;
  anthropicType: string;
  geminiStatus: string;
}

function semanticErrorFor(status: number, retryAfterSeconds: number | null): SemanticErrorShape {
  const retryNote = retryAfterSeconds !== null ? ` Retry after ${retryAfterSeconds}s.` : "";
  if (status === 429) {
    return {
      message: `mock upstream rate limit (injected 429).${retryNote}`,
      openaiType: "rate_limit_error",
      openaiCode: "rate_limit_exceeded",
      anthropicType: "rate_limit_error",
      geminiStatus: "RESOURCE_EXHAUSTED",
    };
  }
  return {
    message: `mock upstream injected status ${status}.${retryNote}`,
    openaiType: "api_error",
    openaiCode: null,
    anthropicType: "api_error",
    geminiStatus: "UNKNOWN",
  };
}

/** 注入错误的 JSON 负载（三种上游方言）。retry_after 字段是带内通道对 Retry-After 头的代偿。 */
function injectedErrorPayload(kind: UpstreamKind, status: number, retryAfterSeconds: number | null): string {
  const s = semanticErrorFor(status, retryAfterSeconds);
  const retryField = retryAfterSeconds !== null ? { retry_after: String(retryAfterSeconds) } : {};
  if (kind === "anthropic") {
    return JSON.stringify({
      type: "error",
      error: { type: s.anthropicType, message: s.message, ...retryField },
    });
  }
  if (kind === "gemini") {
    return JSON.stringify({
      error: { code: status, message: s.message, status: s.geminiStatus, ...retryField },
    });
  }
  return JSON.stringify({
    error: {
      message: s.message,
      type: s.openaiType,
      param: null,
      ...(s.openaiCode ? { code: s.openaiCode } : {}),
      ...retryField,
    },
  });
}

/** 带内 SSE error 事件帧（Anthropic 方言带 event: error 行，其余为裸 data 帧）。 */
function injectedErrorEvent(kind: UpstreamKind, status: number, retryAfterSeconds: number | null): string {
  const data = injectedErrorPayload(kind, status, retryAfterSeconds);
  return kind === "anthropic" ? `event: error\ndata: ${data}\n\n` : `data: ${data}\n\n`;
}

export interface ServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * 独立的 mock upstream：承载四种上游形态。
 * - POST /v1/chat/completions          OpenAI Chat Completions（stream / non-stream）
 * - POST /v1/messages                  Anthropic Messages（stream / non-stream）
 * - POST /v1beta/models/*:generateContent(Alt=SSE) Gemini 原生（stream / non-stream）
 * - POST /jev                          专家路由 classifier（systemone choice 协议）
 *
 * journal 通过 /_internal/journal 暴露，供 worker 线程里的用例断言。
 *
 * 故障注入（供用例验证网关的流式容错/断点续传/退避路径）：
 * - POST /_internal/upstream-fail-mode  { mode: "drop-after-chunks:N" | "mid-stream-status:S" | null,
 *                                         retryAfterSeconds?: number | null }
 *   一次性（one-shot）：armed 后由下一个匹配的 LLM 请求消耗并自动解除，
 *   因此“首请求失败、网关续写/重试的后续请求”天然恢复正常，不会把续写也打死。
 *   /_internal/reset 只清 journal（与 jev-fail-mode 同约定），注入状态由用例显式置 null 清理。
 *   GET  同路径返回当前 { spec, fired }，供清理断言。
 *
 * 协议限制（实现严格遵守真实 HTTP，不做假语义）：
 * - HTTP/1.1 一条响应只有一个状态行。流式路径先 writeHead(200) 再写首帧，
 *   此后不可能再改成 4xx/5xx。mid-stream-status 在流式路径上的真实表达只能是：
 *   ① 状态行保持 200；② 错误语义以带内 SSE error 事件传达（各上游方言）；
 *   ③ 干净 end() 收尾。Retry-After 头同理发不出去，只能并入事件负载（retry_after 字段）。
 * - drop-after-chunks 是传输层中断（socket.destroy，RST）：线上同样没有任何 HTTP 错误语义。
 * - 非流式响应头未提交，mid-stream-status 可以落成真实状态码 + 真实 Retry-After 头。
 * - /jev 不参与本注入（它有自己的 /_internal/jev-fail-mode）。
 */
export async function startMockUpstream(): Promise<ServerHandle> {
  const journal: JournalEntry[] = [];
  let jevFailMode = false;
  let upstreamFailSpec: UpstreamFailModeSpec | null = null;
  let upstreamFailFired = false;

  /** one-shot：取走已武装的注入（并解除武装）。只在真正会命中的分支调用。 */
  function consumeArmedFault(): UpstreamFailModeSpec | null {
    if (!upstreamFailSpec) return null;
    const spec = upstreamFailSpec;
    upstreamFailSpec = null;
    upstreamFailFired = true;
    return spec;
  }

  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };

  /**
   * 流式响应 + 注入。无注入时与原 sse() 逐字节一致（既有用例不受影响）。
   * frames = 事件帧序列（终止帧如 [DONE] 计入帧数）。
   */
  function sseWithFaultInjection(
    kind: Exclude<UpstreamKind, "jev">,
    res: http.ServerResponse,
    entry: JournalEntry,
    events: string[],
    done: string,
  ): void {
    const spec = consumeArmedFault();
    const frames = done ? [...events, done] : events;

    if (!spec) {
      res.writeHead(200, sseHeaders);
      for (const c of events) res.write(c);
      res.end(done);
      return;
    }

    if (spec.mode === "drop-after-chunks") {
      // 写头 + 前 N 帧后 RST 断链。不给 HTTP 层任何错误语义——这正是要模拟的“上游掉线”。
      res.writeHead(200, sseHeaders);
      const written = Math.min(spec.chunks, frames.length);
      for (let i = 0; i < written; i += 1) res.write(frames[i]);
      entry.failure = { mode: "drop-after-chunks", chunksWritten: written, wire: "socket-destroyed" };
      const socket = res.socket;
      res.on("error", () => {});
      socket?.on("error", () => {});
      // 让已写帧先离开用户态再断链，避免 RST 吞掉内核缓冲里的数据
      setImmediate(() => socket?.destroy());
      return;
    }

    // mid-stream-status：状态行即将以 200 提交且此后不可更改；真实协议下唯一通道是带内错误事件。
    res.writeHead(200, sseHeaders);
    const first = frames[0];
    if (first !== undefined) res.write(first);
    res.write(injectedErrorEvent(kind, spec.status, spec.retryAfterSeconds));
    entry.failure = {
      mode: "mid-stream-status",
      status: spec.status,
      retryAfterSeconds: spec.retryAfterSeconds,
      chunksWritten: first !== undefined ? 1 : 0,
      wire: "sse-error-then-end",
    };
    res.end();
  }

  /** 非流式路径：响应头未提交，mid-stream-status 可以落成真实状态码 + 真实 Retry-After 头。 */
  function maybeInjectHttpStatus(
    kind: Exclude<UpstreamKind, "jev">,
    res: http.ServerResponse,
    entry: JournalEntry,
  ): boolean {
    const armed = upstreamFailSpec;
    if (!armed || armed.mode !== "mid-stream-status") return false;
    const spec = consumeArmedFault();
    if (!spec || spec.mode !== "mid-stream-status") return false;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (spec.retryAfterSeconds !== null) headers["retry-after"] = String(spec.retryAfterSeconds);
    res.writeHead(spec.status, headers);
    res.end(injectedErrorPayload(kind, spec.status, spec.retryAfterSeconds));
    entry.failure = {
      mode: "mid-stream-status",
      status: spec.status,
      retryAfterSeconds: spec.retryAfterSeconds,
      chunksWritten: 0,
      wire: "http-status",
    };
    return true;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const path = req.url || "/";
      const auth = req.headers["authorization"] || null;
      const xApiKey = req.headers["x-api-key"] || null;
      const xGoogApiKey = req.headers["x-goog-api-key"] || null;

      if (req.method === "GET" && path === "/_internal/journal") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(journal));
        return;
      }
      if (req.method === "POST" && path === "/_internal/reset") {
        journal.length = 0;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && path === "/_internal/upstream-fail-mode") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spec: upstreamFailSpec, fired: upstreamFailFired }));
        return;
      }
      if (req.method === "POST" && path === "/_internal/upstream-fail-mode") {
        const b = body as { mode?: unknown; retryAfterSeconds?: unknown } | null;
        const parsed = parseUpstreamFailMode(b?.mode, b?.retryAfterSeconds);
        if (!parsed.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: parsed.error }));
          return;
        }
        upstreamFailSpec = parsed.spec;
        upstreamFailFired = false;
        res.writeHead(204);
        res.end();
        return;
      }

      const record = (kind: UpstreamKind): JournalEntry => {
        const entry: JournalEntry = {
          kind,
          path,
          authorization: typeof auth === "string" ? auth : null,
          xApiKey: typeof xApiKey === "string" ? xApiKey : null,
          xGoogApiKey: typeof xGoogApiKey === "string" ? xGoogApiKey : null,
          body,
          at: Date.now(),
        };
        journal.push(entry);
        return entry;
      };

      if (req.method === "POST" && path === "/v1/chat/completions") {
        const entry = record("openai");
        const b = body as { model?: string; stream?: boolean } | null;
        if (b?.stream) {
          sseWithFaultInjection(
            "openai",
            res,
            entry,
            [
              `data: ${JSON.stringify({
                id: "chatcmpl-e2e",
                object: "chat.completion.chunk",
                model: b.model,
                choices: [{ index: 0, delta: { content: "E2E " }, finish_reason: null }],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "chatcmpl-e2e",
                object: "chat.completion.chunk",
                model: b.model,
                choices: [{ index: 0, delta: { content: "openai ok" }, finish_reason: "stop" }],
              })}\n\n`,
            ],
            "data: [DONE]\n\n",
          );
          return;
        }
        if (maybeInjectHttpStatus("openai", res, entry)) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-e2e",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: b?.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "E2E openai ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          }),
        );
        return;
      }

      if (req.method === "POST" && path === "/v1/messages") {
        const entry = record("anthropic");
        const b = body as { model?: string; stream?: boolean } | null;
        if (b?.stream) {
          sseWithFaultInjection(
            "anthropic",
            res,
            entry,
            [
              `event: message_start\ndata: ${JSON.stringify({
                type: "message_start",
                message: { id: "msg_e2e", type: "message", role: "assistant", model: b.model },
              })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "E2E anthropic ok" },
              })}\n\n`,
              `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
            ],
            "",
          );
          return;
        }
        if (maybeInjectHttpStatus("anthropic", res, entry)) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model: b?.model,
            content: [{ type: "text", text: "E2E anthropic ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 11, output_tokens: 7 },
          }),
        );
        return;
      }

      if (req.method === "POST" && path.startsWith("/v1beta/models/")) {
        const entry = record("gemini");
        const streaming = path.includes(":streamGenerateContent");
        const model = path.split("/v1beta/models/")[1]?.split(":")[0];
        if (streaming) {
          sseWithFaultInjection(
            "gemini",
            res,
            entry,
            [
              `data: ${JSON.stringify({
                candidates: [{ content: { parts: [{ text: "E2E " }], role: "model" } }],
              })}\n\n`,
              `data: ${JSON.stringify({
                candidates: [
                  { content: { parts: [{ text: "gemini ok" }], role: "model" }, finishReason: "STOP" },
                ],
                usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
              })}\n\n`,
            ],
            "",
          );
          return;
        }
        if (maybeInjectHttpStatus("gemini", res, entry)) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "E2E gemini ok" }], role: "model" }, finishReason: "STOP" },
            ],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
            modelVersion: model,
          }),
        );
        return;
      }

      if (req.method === "POST" && path === "/_internal/jev-fail-mode") {
        jevFailMode = Boolean((body as { fail?: boolean } | null)?.fail);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && path === "/jev") {
        // 注意：/jev 不参与 /_internal/upstream-fail-mode 注入（classifier 故障走 jev-fail-mode）
        record("jev");
        const b = body as { model?: string } | null;
        if (jevFailMode) {
          // 故障注入：验证专家路由 fail_open=fallback 行为
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "jev classifier unavailable (injected)" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: b?.model,
            answers: {
              model: {
                type: "choice",
                choice: "medium",
                confidence: 0.97,
                probabilities: { low: 0.01, medium: 0.97, high: 0.02 },
              },
            },
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock upstream has no route for ${path}`, type: "not_found" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  void MOCK_UPSTREAM_KEY; // key asserted from journal entries in specs

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function fetchJournal(mockBaseUrl: string): Promise<JournalEntry[]> {
  const res = await fetch(`${mockBaseUrl}/_internal/journal`);
  if (!res.ok) throw new Error(`journal fetch failed: HTTP ${res.status}`);
  return (await res.json()) as JournalEntry[];
}

export async function resetJournal(mockBaseUrl: string): Promise<void> {
  await fetch(`${mockBaseUrl}/_internal/reset`, { method: "POST" });
}

/** 故障注入开关：/jev 返回 503，验证专家路由 fail_open=fallback。 */
export async function setJevFailMode(mockBaseUrl: string, fail: boolean): Promise<void> {
  await fetch(`${mockBaseUrl}/_internal/jev-fail-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fail }),
  });
}

/**
 * 上游故障注入开关（one-shot）：
 * - "drop-after-chunks:N"  流式响应写完前 N 个 SSE 帧后 RST 断链（只命中流式请求）
 * - "mid-stream-status:S"  流式：200 状态行保持不变 + 带内 SSE error 事件 + 干净收尾；
 *                          非流式：真实 S 状态码（+ 可选真实 Retry-After 头）
 * - null                   清除注入
 * 命中即自动解除武装，保证“首请求失败、续写/重试请求正常”。
 */
export async function setUpstreamFailMode(
  mockBaseUrl: string,
  mode: string | null,
  retryAfterSeconds?: number | null,
): Promise<void> {
  const res = await fetch(`${mockBaseUrl}/_internal/upstream-fail-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, retryAfterSeconds: retryAfterSeconds ?? null }),
  });
  if (!res.ok) {
    throw new Error(`upstream fail-mode set failed: HTTP ${res.status} ${await res.text()}`);
  }
}

/** 当前注入状态视图（{ spec, fired }），供清理/one-shot 断言。 */
export async function fetchUpstreamFailMode(mockBaseUrl: string): Promise<UpstreamFailModeView> {
  const res = await fetch(`${mockBaseUrl}/_internal/upstream-fail-mode`);
  if (!res.ok) throw new Error(`upstream fail-mode fetch failed: HTTP ${res.status}`);
  return (await res.json()) as UpstreamFailModeView;
}
