/**
 * Responses 续传使用独立上游脚本：共享 mock 不支持此端点或逐请求故障。
 * delta 使用真实 API 的字符串形态；各场景使用独立 model identifier，
 * 避免共享熔断器状态导致执行顺序依赖。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import mysql from "mysql2/promise";
import { ctx } from "./helpers.js";

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 续写指令原文（backend services/stream-resumer.ts STREAM_RESUME_INSTRUCTION 的
 * 逐字拷贝；Responses 续写按同一常量断言）。故意内联而不是 import：import 会把
 * backend 的 db/index 池拉进测试进程。文案漂移时此断言应失败并更新本拷贝。
 */
const RESUME_INSTRUCTION =
  "Your previous reply was cut off by a transient network error right after the assistant text above. " +
  "Continue that reply exactly from where it stopped. " +
  "Do not repeat, rephrase, or summarize text you already output, and do not mention the interruption.";

const LOCAL_PROVIDER_ID = "prov-e2e-responses-local";
const MARKERS = [
  "responses-resume-e2e-failed-event",
  "responses-resume-e2e-rst-ok",
  "responses-resume-e2e-cont429",
  "responses-resume-e2e-abort",
  "responses-resume-e2e-tool",
  "responses-resume-e2e-second-fail",
] as const;
const localModel = (marker: string): string => `gpt-${marker}`;
const localIdentifier = (marker: string): string => `mock-${marker}`;
const localVk = (marker: string): string => `sk-e2e-${marker}`;
const UPSTREAM_KEY = "e2e-upstream-key"; // 与全局 seed 相同的 provider apiKey

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── SSE 解析（下游侧，本文件局部） ──────────────────────────────────────────

interface SseFrame {
  /** event: 行的值；裸 data 帧为 null（本链路所有上游事件都带 event: 行） */
  event: string | null;
  /** data: 行的负载原文 */
  data: string;
}

/** SSE 原文 → 事件帧列表（丢弃 ': ping' 注释心跳等非 data 帧）。 */
function sseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) continue; // 注释心跳 / 空块
    frames.push({
      event: lines.find((l) => l.startsWith("event:"))?.slice("event:".length).trim() ?? null,
      data: dataLines.map((l) => l.slice("data:".length).trim()).join("\n"),
    });
  }
  return frames;
}

/** 事件帧的 JSON 负载；event 为 type 字段名（帧负载自身也带同值 type）。 */
function payloadsOf(raw: string, type: string): any[] {
  return sseFrames(raw)
    .filter((f) => f.event === type)
    .map((f) => JSON.parse(f.data));
}

/**
 * 拼接全部 response.output_text.delta 的文本。兼容两种 delta 形状：
 * 规格裸字符串（真实上游/SDK）与 {text} 对象（网关 WS 适配器内部形状）。
 */
function stitchedText(raw: string): string {
  return payloadsOf(raw, "response.output_text.delta")
    .map((p) => (typeof p.delta === "string" ? p.delta : p.delta?.text ?? ""))
    .join("");
}

// ─── MySQL 直查（api_requests 缓冲写入，轮询；按 user 标记精确定位行） ────────

async function query(sql: string, params: unknown[]): Promise<Record<string, any>[]> {
  const env = ctx().mysql;
  const conn = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
  });
  try {
    const [rows] = await conn.query(sql, params);
    return rows as Record<string, any>[];
  } finally {
    await conn.end();
  }
}

/** 轮询 api_requests 中 request_params_json.user = marker 的最新行。 */
async function pollRowByUserMarker(marker: string, timeoutMs = 15_000): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const rows = await query(
        "SELECT id, model, status, error_message, prompt_tokens, completion_tokens, request_params_json " +
          "FROM api_requests WHERE JSON_UNQUOTE(JSON_EXTRACT(request_params_json, '$.user')) = ? " +
          "ORDER BY created_at DESC LIMIT 3",
        [marker],
      );
      if (rows.length > 0) return rows[0];
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(
    `no api_requests row with user marker "${marker}" within ${timeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr})` : ""),
  );
}

/** mysql2 会把 JSON 列解析成对象，也可能是字符串 —— 统一成对象。 */
function paramsOf(row: Record<string, any>): Record<string, any> {
  const raw = row.request_params_json;
  if (raw === null || raw === undefined) return {};
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// ─── admin API（登录 global-setup 播种的 e2e-admin，非凭据存储） ───────────────

let adminToken = "";

async function adminLogin(): Promise<void> {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "e2e-admin", password: "e2e-password-123456" }),
  });
  if (!res.ok) throw new Error(`admin login failed: HTTP ${res.status} ${await res.text()}`);
  adminToken = ((await res.json()) as { token: string }).token;
}

const adminHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${adminToken}`,
});

/** 开关系统设置 stream_resume_enabled（POST /api/admin/config/system-settings）。 */
async function setStreamResume(enabled: boolean): Promise<void> {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/api/admin/config/system-settings`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ streamResumeEnabled: enabled }),
  });
  if (!res.ok) throw new Error(`set streamResumeEnabled=${enabled} failed: HTTP ${res.status} ${await res.text()}`);
  const view = (await (
    await fetch(`${c.gatewayBaseUrl}/api/admin/config/system-settings`, { headers: adminHeaders() })
  ).json()) as { streamResumeEnabled?: boolean };
  if (view.streamResumeEnabled !== enabled) {
    throw new Error(`stream_resume_enabled round-trip mismatch: expected ${enabled}, got ${view.streamResumeEnabled}`);
  }
}

// ─── local upstream：OpenAI Responses API 方言，逐请求脚本 ────────────────────

interface LocalCall {
  body: any;
  authorization: string | null;
  /** 网关主动断开（abort）时置 true —— 只有 stall 场景有意义。 */
  clientClosed: boolean;
  failure?: { kind: string; retryAfterSeconds?: number };
}

type Scenario = {
  name: string;
  respond: (callIndex: number, res: http.ServerResponse, call: LocalCall) => void;
};

const localCalls: LocalCall[] = [];
let scenario: Scenario | null = null;
const setScenario = (s: Scenario): void => {
  scenario = s;
};

const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};

/** 一帧事件：event 行 + data 行（负载自带 type 字段，与真实上游一致）。 */
function ev(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

interface RespIds {
  resp: string;
  msg: string;
}

const IDS_INITIAL: RespIds = { resp: "resp_e2e_initial", msg: "msg_e2e_initial" };
const IDS_CONT: RespIds = { resp: "resp_e2e_cont", msg: "msg_e2e_cont" };

function createdEvent(model: string, ids: RespIds): string {
  return ev("response.created", {
    response: {
      id: ids.resp,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
    },
  });
}

function itemAddedEvent(ids: RespIds, outputIndex = 0): string {
  return ev("response.output_item.added", {
    output_index: outputIndex,
    item: { id: ids.msg, type: "message", role: "assistant", status: "in_progress", content: [] },
  });
}

function partAddedEvent(ids: RespIds, outputIndex = 0): string {
  return ev("response.content_part.added", {
    item_id: ids.msg,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
}

/** 规格形状：delta 是裸字符串。 */
function textDeltaEvent(ids: RespIds, text: string, outputIndex = 0): string {
  return ev("response.output_text.delta", {
    item_id: ids.msg,
    output_index: outputIndex,
    content_index: 0,
    delta: text,
  });
}

function textDoneEvent(ids: RespIds, text: string, outputIndex = 0): string {
  return ev("response.output_text.done", {
    item_id: ids.msg,
    output_index: outputIndex,
    content_index: 0,
    text,
  });
}

function partDoneEvent(ids: RespIds, text: string, outputIndex = 0): string {
  return ev("response.content_part.done", {
    item_id: ids.msg,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text, annotations: [] },
  });
}

function messageItem(ids: RespIds, text: string): Record<string, unknown> {
  return {
    id: ids.msg,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function itemDoneEvent(ids: RespIds, text: string, outputIndex = 0): string {
  return ev("response.output_item.done", {
    output_index: outputIndex,
    item: messageItem(ids, text),
  });
}

function completedEvent(model: string, ids: RespIds, text: string): string {
  return ev("response.completed", {
    response: {
      id: ids.resp,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model,
      output: [messageItem(ids, text)],
      usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
    },
  });
}

/** function_call 输出项（工具调用）：type=function_call 的 output item。 */
function functionCallAddedEvent(outputIndex = 1): string {
  return ev("response.output_item.added", {
    output_index: outputIndex,
    item: {
      id: "fc_e2e",
      type: "function_call",
      call_id: "call_e2e",
      name: "e2e_tool",
      arguments: "",
      status: "in_progress",
    },
  });
}

function functionArgsDeltaEvent(outputIndex = 1): string {
  return ev("response.function_call_arguments.delta", {
    item_id: "fc_e2e",
    output_index: outputIndex,
    delta: '{"query"',
  });
}

/** 初始段前缀（created/item/part 三帧 —— 头在 output_item.added 即提交）。 */
function writePrefix(res: http.ServerResponse, model: string, ids: RespIds): void {
  res.write(createdEvent(model, ids));
  res.write(itemAddedEvent(ids));
  res.write(partAddedEvent(ids));
}

/** 传输层 RST：写完已有帧后摧毁 socket（无任何 HTTP/SSE 错误语义）。 */
function rst(res: http.ServerResponse, call: LocalCall, kind: string): void {
  call.failure = { kind };
  res.on("error", () => {});
  res.socket?.on("error", () => {});
  setImmediate(() => res.socket?.destroy());
}

/** 场景 A：初始段一条文本 delta 后 RST；续写调用（i>=1）回“只含尾巴”的新 response。 */
const rstMidTextThenOk: Scenario = {
  name: "rst-mid-text-then-ok",
  respond: (i, res, call) => {
    const model = call.body?.model;
    if (i === 0) {
      res.writeHead(200, SSE_HEADERS);
      writePrefix(res, model, IDS_INITIAL);
      res.write(textDeltaEvent(IDS_INITIAL, "E2E "));
      rst(res, call, "rst-after-first-delta");
      return;
    }
    // 续写段：遵循续写指令的“好上游” —— 新 response 只输出未完成的尾巴。
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, model, IDS_CONT);
    res.write(textDeltaEvent(IDS_CONT, "responses ok"));
    res.write(textDoneEvent(IDS_CONT, "responses ok"));
    res.write(partDoneEvent(IDS_CONT, "responses ok"));
    res.write(itemDoneEvent(IDS_CONT, "responses ok"));
    res.write(completedEvent(model, IDS_CONT, "responses ok"));
    res.end();
  },
};

/** 场景 B：首条文本 delta 后停住不结束 —— 给客户端留出确定性 abort 窗口。 */
const stallAfterFirstDelta: Scenario = {
  name: "stall-after-first-delta",
  respond: (_i, res, call) => {
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, call.body?.model, IDS_INITIAL);
    res.write(textDeltaEvent(IDS_INITIAL, "E2E stall"));
    call.failure = { kind: "stalled-after-first-delta" };
    // 故意不 end()：等网关（客户端 abort）或超时
  },
};

/** 场景 C：文本 delta + function_call 输出项 + arguments delta，然后 RST —— 非文本输出不可续写。 */
const functionCallThenRst: Scenario = {
  name: "text+function_call-then-rst",
  respond: (_i, res, call) => {
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, call.body?.model, IDS_INITIAL);
    res.write(textDeltaEvent(IDS_INITIAL, "E2E "));
    res.write(functionCallAddedEvent(1));
    res.write(functionArgsDeltaEvent(1));
    rst(res, call, "rst-after-function_call-delta");
  },
};

/** 场景 D：每次调用都在一条文本 delta 后 RST —— 第一次触发续写，续写流再死即二次失败。 */
const rstEveryCall = (first: string, rest: string): Scenario => ({
  name: `rst-every-call(${first}|${rest})`,
  respond: (i, res, call) => {
    const ids = i === 0 ? IDS_INITIAL : IDS_CONT;
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, call.body?.model, ids);
    res.write(textDeltaEvent(ids, i === 0 ? first : rest));
    rst(res, call, i === 0 ? "rst-initial" : "rst-continuation");
  },
});

/**
 * 场景 E：初始段一条文本 delta 后 RST；续写调用回一条增量后以 response.failed
 * 终态事件收场（HTTP 200 + SSE 失败终态，非传输层错误）。处理器会吞掉续写
 * 流自带的失败终态、按原始身份重新合成后仍按成功返回；审计是否记 error
 * 由 proxy 的独立信号（chunk 磁带扫描 / 处理器显式字段）判定，本场景验证
 * 该接线。
 */
const rstThenContinuationFailed: Scenario = {
  name: "rst-then-continuation-failed",
  respond: (i, res, call) => {
    const model = call.body?.model;
    if (i === 0) {
      res.writeHead(200, SSE_HEADERS);
      writePrefix(res, model, IDS_INITIAL);
      res.write(textDeltaEvent(IDS_INITIAL, "E2E "));
      rst(res, call, "rst-after-first-delta");
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, model, IDS_CONT);
    res.write(textDeltaEvent(IDS_CONT, "doomed tail"));
    res.write(
      ev("response.failed", {
        response: {
          id: IDS_CONT.resp,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "failed",
          model,
          error: { code: "server_error", message: "e2e continuation upstream exploded" },
          output: [],
        },
      }),
    );
    res.end();
  },
};

/**
 * 场景 F：初始段一条文本 delta 后 RST；第 2 次调用（续写创建）回真实 HTTP
 * 429 + Retry-After 头；第 3 次起回“只含尾巴”的正常续写流。验证 Responses
 * 续写创建重试：等待 Retry-After 后重试成功、拼接，并对账 journal（续写
 * 调用次数）与 metadata（stream_resume_attempts = 创建次数）。
 */
const contCreation429ThenOk = (retryAfterSeconds: number): Scenario => ({
  name: `continuation-creation-429(retry-after=${retryAfterSeconds}s)`,
  respond: (i, res, call) => {
    const model = call.body?.model;
    if (i === 0) {
      res.writeHead(200, SSE_HEADERS);
      writePrefix(res, model, IDS_INITIAL);
      res.write(textDeltaEvent(IDS_INITIAL, "E2E "));
      rst(res, call, "rst-after-first-delta");
      return;
    }
    if (i === 1) {
      call.failure = { kind: "creation-rejected-429", retryAfterSeconds };
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      });
      res.end(
        JSON.stringify({
          error: {
            message: "local responses mock rate limit (injected 429)",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
      );
      return;
    }
    // Retry-After 等待后的续写创建成功：遵循续写指令的“好上游”只输出尾巴。
    res.writeHead(200, SSE_HEADERS);
    writePrefix(res, model, IDS_CONT);
    res.write(textDeltaEvent(IDS_CONT, "responses ok"));
    res.write(textDoneEvent(IDS_CONT, "responses ok"));
    res.write(partDoneEvent(IDS_CONT, "responses ok"));
    res.write(itemDoneEvent(IDS_CONT, "responses ok"));
    res.write(completedEvent(model, IDS_CONT, "responses ok"));
    res.end();
  },
});

async function startLocalUpstream(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.on("error", () => {});
    req.on("error", () => {});
    const chunks: Buffer[] = [];
    let call: LocalCall | null = null;
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("close", () => {
      // 响应尚未结束就断开 = 网关 abort 了上游连接（stall 场景断言用）
      if (call && !res.writableEnded) call.clientClosed = true;
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      call = {
        body,
        authorization: typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : null,
        clientClosed: false,
      };
      localCalls.push(call);
      if (req.method === "POST" && req.url === "/v1/responses" && scenario) {
        scenario.respond(localCalls.length - 1, res, call);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "local responses upstream: no scenario" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.00.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function seedLocalUpstream(baseUrl: string): Promise<void> {
  const c = ctx();
  const post = async (path: string, body: unknown): Promise<Record<string, any>> => {
    const res = await fetch(`${c.gatewayBaseUrl}${path}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, any>;
  };
  await post("/api/admin/providers", {
    id: LOCAL_PROVIDER_ID,
    name: "E2E Responses Local Upstream",
    baseUrl,
    apiKey: UPSTREAM_KEY,
    // OpenAI SDK 以 baseURL 拼 /responses → 映射须自带 /v1（同 chat 链路约定）
    protocolMappings: { openai: `${baseUrl}/v1` },
    enabled: true,
  });
  for (const marker of MARKERS) {
    const { id: modelId } = await post("/api/admin/models", {
      name: localModel(marker),
      providerId: LOCAL_PROVIDER_ID,
      modelIdentifier: localIdentifier(marker),
      enabled: true,
    });
    await post("/api/admin/virtual-keys", {
      name: `e2e-vk-${marker}`,
      modelId,
      keyType: "custom",
      customKey: localVk(marker),
      routingStrategy: "single",
      enabled: true,
    });
  }
}

// ─── 客户端（对网关发 /v1/responses 流式请求） ────────────────────────────────

/** 原始输入数组：一条带 content 部件的 user 消息（Responses input 的规范形态）。 */
function originalInput(prompt: string): Array<Record<string, unknown>> {
  return [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
}

async function streamResponses(options: {
  marker: string;
  prompt: string;
  tools?: unknown[];
  signal?: AbortSignal;
}): Promise<Response> {
  const c = ctx();
  return fetch(`${c.gatewayBaseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${localVk(options.marker)}`,
    },
    signal: options.signal,
    body: JSON.stringify({
      model: localModel(options.marker),
      stream: true, // 网关对 /v1/responses 只支持流式（responses_non_stream_not_supported）
      user: options.marker,
      instructions: "e2e responses instructions",
      store: false,
      input: originalInput(options.prompt),
      ...(options.tools ? { tools: options.tools } : {}),
    }),
  });
}

const E2E_TOOL = {
  type: "function",
  name: "e2e_tool",
  description: "e2e responses resume tool",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

async function waitForUpstreamAbort(call: LocalCall, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!call.clientClosed && Date.now() < deadline) await sleep(100);
  if (!call.clientClosed) {
    throw new Error("upstream never observed the gateway aborting the connection");
  }
}

let localUpstream: { baseUrl: string; close: () => Promise<void> } | null = null;

// ─── 生命周期 ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await adminLogin();
  localUpstream = await startLocalUpstream();
  await seedLocalUpstream(localUpstream.baseUrl);
}, 60_000);

beforeEach(async () => {
  localCalls.length = 0;
  scenario = null;
});

afterEach(async () => {
  // 恢复默认关闭（与全新网关的出厂状态一致），避免泄漏到其他用例
  await setStreamResume(false);
});

afterAll(async () => {
  await setStreamResume(false);
  await localUpstream?.close();
});

// ─── 用例 ─────────────────────────────────────────────────────────────────────
// 每个 marker 对应独立熔断器 key；用例不依赖排列顺序。

test("continuation response.failed is audited as an error with estimated tokens", async () => {
  const marker = "responses-resume-e2e-failed-event";
  await setStreamResume(true);
  setScenario(rstThenContinuationFailed);

  const res = await streamResponses({ marker, prompt: "e2e continuation fails" });
  expect(res.status).toBe(200);
  const raw = await res.text();
  expect(stitchedText(raw)).toBe("E2E doomed tail");
  const failed = payloadsOf(raw, "response.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0].response.error.message).toBe("e2e continuation upstream exploded");
  expect(failed[0].response.output[0].content[0].text).toBe("E2E doomed tail");
  expect(raw).not.toContain("event: response.completed");
  expect(localCalls).toHaveLength(2);

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBe("e2e continuation upstream exploded");
  expect(Number(row.prompt_tokens)).toBeGreaterThan(0);
  expect(Number(row.completion_tokens)).toBeGreaterThan(0);
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  expect(params.stream_resume_attempts).toBe(localCalls.length - 1);
  const partial = localCalls[1].body.input.at(-2).content[0].text;
  expect(params.stream_resume_chars).toBe(partial.length);
});

test("upstream RST mid-text, resume enabled: single coherent downstream event stream + continuation request carries partial text & instruction", async () => {
  const marker = "responses-resume-e2e-rst-ok";
  const prompt = "e2e responses resume happy path";
  await setStreamResume(true);
  setScenario(rstMidTextThenOk);

  const res = await streamResponses({ marker, prompt });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const raw = await res.text();

  // —— 单条一致事件流：文本不重不漏（续写段脚本刻意不重复前缀，若网关重放即失败）——
  expect(stitchedText(raw)).toBe("E2E responses ok");

  // —— 终止事件：唯一 response.completed，且在全部文本 delta 之后、[DONE] 之前 ——
  const completedFrames = sseFrames(raw).filter((f) => f.event === "response.completed");
  expect(completedFrames).toHaveLength(1);
  const lastDeltaIdx = raw.lastIndexOf("event: response.output_text.delta");
  const completedIdx = raw.indexOf("event: response.completed");
  const doneIdx = raw.indexOf("data: [DONE]");
  expect(lastDeltaIdx).toBeGreaterThan(-1);
  expect(completedIdx).toBeGreaterThan(lastDeltaIdx);
  expect(doneIdx).toBeGreaterThan(completedIdx);
  expect(JSON.parse(completedFrames[0].data).response.status).toBe("completed");

  // —— 收尾：恰好一个 [DONE] 且是最后一帧；失败语义（error 帧/response.failed）不存在 ——
  const frames = sseFrames(raw);
  expect(frames.filter((f) => f.data === "[DONE]")).toHaveLength(1);
  expect(frames.at(-1)?.data).toBe("[DONE]");
  expect(raw).not.toContain("event: error");
  expect(raw).not.toContain("response.failed");
  expect(raw).not.toContain("response.incomplete");

  // —— 上游视角：初始请求 + 唯一一段续写 ——
  expect(localCalls).toHaveLength(2);
  expect(localCalls[0].failure).toMatchObject({ kind: "rst-after-first-delta" });
  expect(localCalls[1].failure).toBeUndefined();
  expect(localCalls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);

  // —— 续写请求输入：model 改写为 model_identifier；input = 原始输入 + 半截
  //    assistant 文本 + 续写指令；user 标记透传 ——
  const cont = localCalls[1].body as Record<string, any>;
  expect(cont.model).toBe(localIdentifier(marker));
  expect(cont.stream).toBe(true);
  expect(cont.user).toBe(marker);
  expect(Array.isArray(cont.input)).toBe(true);
  const contInput = cont.input as Array<Record<string, any>>;
  expect(contInput[0]).toEqual(originalInput(prompt)[0]); // 原始输入原样保留在头部
  const instructionItem = contInput.at(-1) as Record<string, any> | undefined;
  expect(JSON.stringify(instructionItem)).toContain(RESUME_INSTRUCTION); // 续写指令在末条
  const partialItem = contInput.find(
    (item) => item?.role === "assistant" && JSON.stringify(item).includes("E2E "),
  );
  expect(partialItem).toBeDefined(); // 已输出文本回传给上游
  expect(contInput.indexOf(partialItem!)).toBe(contInput.length - 2); // 紧邻续写指令之前

  // —— 落库：续写成功 → 整体记成功并带续写标记 ——
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("success");
  expect([localModel(marker), localIdentifier(marker)]).toContain(row.model);
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  expect(params.stream_resume_attempts).toBe(localCalls.length - 1);
  expect(params.stream_resume_chars).toBe(partialItem!.content[0].text.length);
  expect(Number(row.prompt_tokens)).toBeGreaterThan(0);
  expect(Number(row.completion_tokens)).toBeGreaterThan(0);
});

test("continuation creation rejected with HTTP 429: gateway retries and stitches; journal ↔ metadata reconcile", async () => {
  const marker = "responses-resume-e2e-cont429";
  const prompt = "e2e responses continuation creation 429";
  const retryAfterSeconds = 1;
  await setStreamResume(true);
  setScenario(contCreation429ThenOk(retryAfterSeconds));

  const res = await streamResponses({ marker, prompt });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const raw = await res.text();

  // —— 下游单条一致事件流：不重不漏 + 唯一终止 + 唯一 [DONE] + 无错误帧 ——
  expect(stitchedText(raw)).toBe("E2E responses ok");
  const completedFrames = sseFrames(raw).filter((f) => f.event === "response.completed");
  expect(completedFrames).toHaveLength(1);
  const frames = sseFrames(raw);
  expect(frames.filter((f) => f.data === "[DONE]")).toHaveLength(1);
  expect(frames.at(-1)?.data).toBe("[DONE]");
  expect(raw).not.toContain("event: error");
  expect(raw).not.toContain("response.failed");
  expect(raw).not.toContain("response.incomplete");
  // —— journal 对账：初始请求 + 被 429 拒绝的续写创建 + 重试成功的续写创建 ——
  expect(localCalls).toHaveLength(3);
  expect(localCalls[0].failure).toMatchObject({ kind: "rst-after-first-delta" });
  expect(localCalls[1].failure).toMatchObject({ kind: "creation-rejected-429", retryAfterSeconds });
  expect(localCalls[2].failure).toBeUndefined();
  expect(localCalls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
  // 两次续写创建的请求体一致：input = 原始输入 + 半截 assistant 文本 + 续写指令
  const firstCreation = localCalls[1].body as Record<string, any>;
  const retryCreation = localCalls[2].body as Record<string, any>;
  expect(retryCreation.input).toEqual(firstCreation.input);
  expect(retryCreation.model).toBe(localIdentifier(marker));
  expect(retryCreation.stream).toBe(true);
  expect(retryCreation.user).toBe(marker);
  expect(retryCreation.tool_choice).toBe("none"); // 续写禁用工具
  const contInput = retryCreation.input as Array<Record<string, any>>;
  expect(contInput[0]).toEqual(originalInput(prompt)[0]);
  expect(JSON.stringify(contInput.at(-1))).toContain(RESUME_INSTRUCTION);
  const partialItem = contInput.find(
    (item) => item?.role === "assistant" && JSON.stringify(item).includes("E2E "),
  );
  expect(partialItem).toBeDefined();
  expect(contInput.indexOf(partialItem!)).toBe(contInput.length - 2);

  // —— metadata 对账：stream_resume_attempts = 上游续写请求创建次数
  //    （= journal 续写调用次数 = localCalls.length - 1，含被 429 拒绝的那次；
  //      初始请求不计），仍只采纳一段续写 ——
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("success");
  expect(row.error_message).toBeFalsy();
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  expect(params.stream_resume_attempts).toBe(localCalls.length - 1);
  expect(params.stream_resume_attempts).toBe(2);
  expect(params.stream_resume_chars).toBe(partialItem!.content[0].text.length);
  expect(Number(row.prompt_tokens)).toBeGreaterThan(0);
  expect(Number(row.completion_tokens)).toBeGreaterThan(0);
});

test("client abort mid-stream (resume enabled): no continuation, gateway aborts upstream, 'Client aborted' error row", async () => {
  const marker = "responses-resume-e2e-abort";
  await setStreamResume(true);
  setScenario(stallAfterFirstDelta);

  const ac = new AbortController();
  const res = await streamResponses({ marker, prompt: "e2e responses client abort", signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  // 确定性窗口：上游停帧 → 客户端读到首条文本 delta 后 abort
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("E2E stall")) {
    const r = await reader.read();
    if (r.done) break;
    seen += decoder.decode(r.value, { stream: true });
  }
  expect(seen).toContain("E2E stall");
  ac.abort();
  let tail = "";
  try {
    const r = await reader.read();
    if (!r.done) tail += decoder.decode(r.value, { stream: true });
  } catch {
    // undici abort：读取抛 AbortError，符合预期
  }
  expect(tail).not.toContain("[DONE]");

  // 网关观察到 close → abort 上游（local upstream 感知到）→ 不做任何续写
  expect(localCalls).toHaveLength(1);
  await waitForUpstreamAbort(localCalls[0]);
  expect(localCalls[0].body.model).toBe(localIdentifier(marker));
  expect(localCalls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);

  // abort 是客户端行为：错误行（'Client aborted'），无续写标记
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBe("Client aborted");
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("function_call output item flushed (resume enabled): non-text output is not resumable — terminal, one upstream call", async () => {
  const marker = "responses-resume-e2e-tool";
  await setStreamResume(true);
  setScenario(functionCallThenRst);

  const res = await streamResponses({
    marker,
    prompt: "e2e responses function call no resume",
    tools: [E2E_TOOL],
  });
  expect(res.status).toBe(200);
  const raw = await res.text();

  // 断链前已冲刷的内容原样到达：文本 delta + function_call 项 + arguments delta
  expect(stitchedText(raw)).toBe("E2E ");
  const argDeltas = payloadsOf(raw, "response.function_call_arguments.delta");
  expect(argDeltas).toHaveLength(1);
  expect(argDeltas[0].delta).toBe('{"query"');

  // 终态：带内 error 帧收尾，没有 [DONE] / 终止事件
  expect(raw).toContain("event: error");
  expect(raw).not.toContain("data: [DONE]");
  expect(raw).not.toContain("response.completed");

  // function_call 不可续写 → 网关不发起第二次上游调用
  expect(localCalls).toHaveLength(1);
  expect(localCalls[0].failure).toMatchObject({ kind: "rst-after-function_call-delta" });

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBeTruthy();
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("second upstream failure after a resume was adopted is terminal: exactly one continuation segment", async () => {
  const marker = "responses-resume-e2e-second-fail";
  await setStreamResume(true);
  setScenario(rstEveryCall("E2E ", "again "));

  const res = await streamResponses({ marker, prompt: "e2e responses second failure terminal" });
  expect(res.status).toBe(200);
  const raw = await res.text();

  // 初始段 "E2E " + 续写段 "again " 都已冲刷；续写段再死 → 终态
  expect(stitchedText(raw)).toBe("E2E again ");
  expect(raw).toContain("event: error");
  expect(raw).not.toContain("data: [DONE]");
  expect(raw).not.toContain("response.completed");

  // 初始 + 唯一一段续写（续写请求同样带 partial + 指令）
  expect(localCalls).toHaveLength(2);
  const cont = localCalls[1].body as Record<string, any>;
  expect(cont.model).toBe(localIdentifier(marker));
  const contInput = cont.input as Array<Record<string, any>>;
  expect(JSON.stringify(contInput.at(-1))).toContain(RESUME_INSTRUCTION);
  expect(
    contInput.find((item) => item?.role === "assistant" && JSON.stringify(item).includes("E2E ")),
  ).toBeDefined();
  expect(localCalls[1].failure).toMatchObject({ kind: "rst-continuation" });

  // 错误路径的落库行从不携带续写标记（error 分支不传 streamResume）
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBeTruthy();
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});
