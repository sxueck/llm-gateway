import http from "node:http";
import type { AddressInfo } from "node:net";
import { MOCK_UPSTREAM_KEY } from "./env.js";

export type UpstreamKind = "openai" | "anthropic" | "gemini" | "jev";

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
}

interface ServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * 独立的 mock upstream：承载四种上游形态。
 * - POST /v1/chat/completions          OpenAI Chat Completions（stream / non-stream）
 * - POST /v1/messages                  Anthropic Messages（stream / non-stream）
 * - POST /v1beta/models/*:generateContent(Alt=SSE) Gemini 原生（stream / non-stream）
 * - POST /jev                          专家路由 classifier（systemone choice 协议）
 * journal 通过 /_internal/journal 暴露，供 worker 线程里的用例断言。
 */
export async function startMockUpstream(): Promise<ServerHandle> {
  const journal: JournalEntry[] = [];
  let jevFailMode = false;

  function sse(res: http.ServerResponse, chunks: string[], done: string) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const c of chunks) res.write(c);
    res.end(done);
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

      const record = (kind: UpstreamKind) =>
        journal.push({
          kind,
          path,
          authorization: typeof auth === "string" ? auth : null,
          xApiKey: typeof xApiKey === "string" ? xApiKey : null,
          xGoogApiKey: typeof xGoogApiKey === "string" ? xGoogApiKey : null,
          body,
          at: Date.now(),
        });

      if (req.method === "POST" && path === "/v1/chat/completions") {
        record("openai");
        const b = body as { model?: string; stream?: boolean } | null;
        if (b?.stream) {
          sse(
            res,
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
        record("anthropic");
        const b = body as { model?: string; stream?: boolean } | null;
        if (b?.stream) {
          sse(
            res,
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
        record("gemini");
        const streaming = path.includes(":streamGenerateContent");
        const model = path.split("/v1beta/models/")[1]?.split(":")[0];
        if (streaming) {
          sse(
            res,
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
