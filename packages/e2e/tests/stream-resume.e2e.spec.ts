/**
 * Chat Completions 断链续写：共享 mock 注入带内错误，本地上游模拟 HTTP 429、
 * 停帧及逐请求响应。mock 重放前缀用于记录网关不做重叠去重的行为。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import mysql from "mysql2/promise";
import { bearerHeaders, ctx, journalOf, resetJournalBeforeEach } from "./helpers.js";
import { fetchUpstreamFailMode, setUpstreamFailMode } from "../src/helpers/mock-upstream.js";

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/**
 * 续写指令原文（backend services/stream-resumer.ts STREAM_RESUME_INSTRUCTION 的
 * 逐字拷贝）。故意内联而不是 import：import 会把 backend 的 db/index 池拉进测试
 * 进程。文案漂移时此断言应失败并更新本拷贝。
 */
const RESUME_INSTRUCTION =
  "Your previous reply was cut off by a transient network error right after the assistant text above. " +
  "Continue that reply exactly from where it stopped. " +
  "Do not repeat, rephrase, or summarize text you already output, and do not mention the interruption.";

const LOCAL_PROVIDER_ID = "prov-e2e-resume-local";
const LOCAL_MODEL = "gpt-resume-e2e"; // 网关侧模型名
const LOCAL_IDENTIFIER = "mock-gpt-resume"; // 上游侧 model_identifier
const LOCAL_VK = "sk-e2e-resume-local-0001";
const UPSTREAM_KEY = "e2e-upstream-key"; // 与全局 seed 相同的 provider apiKey

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SSE 原文 → 以 "data:" 开头的完整事件帧负载（不含 event: 帧、注释心跳）。 */
function sseDataFrames(raw: string): string[] {
  return raw
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice("data:".length).trim());
}

/** 从 SSE 原文提取 data 帧的 delta.content 拼接文本。 */
function stitchedText(raw: string): string {
  return sseDataFrames(raw)
    .filter((f) => f !== "[DONE]")
    .map((f) => JSON.parse(f).choices?.[0]?.delta?.content ?? "")
    .join("");
}

/** 从 SSE 原文提取第一个 event: error 帧的 JSON 负载。 */
function sseErrorPayload(raw: string): Record<string, any> {
  const frame = raw.split("\n\n").find((f) => f.startsWith("event: error"));
  if (!frame) throw new Error(`no event: error frame in SSE output:\n${raw}`);
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`event: error frame has no data line:\n${frame}`);
  return JSON.parse(dataLine.slice("data:".length).trim());
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

// ─── local upstream（脚本可控的第二上游） ──────────────────────────────────────

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

function chunkFrame(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-resume-local",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** 传输层 RST：写完已有帧后摧毁 socket，与全局 mock 的 drop-after-chunks 同语义。 */
function rst(res: http.ServerResponse, call: LocalCall, kind: string): void {
  call.failure = { kind };
  res.on("error", () => {});
  res.socket?.on("error", () => {});
  setImmediate(() => res.socket?.destroy());
}

/** 场景 A：首帧后停住不结束 —— 给客户端留出确定性 abort 窗口。 */
const stallAfterFirstFrame: Scenario = {
  name: "stall-after-first-frame",
  respond: (_i, res, call) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(chunkFrame(call.body.model, { content: "E2E stall" }));
    call.failure = { kind: "stalled-after-first-frame" };
    // 故意不 end()：等网关（客户端 abort）或超时
  },
};

/** 场景 B：文本帧 + tool_call 增量帧，然后 RST —— sawNonTextDelta 应禁止续写。 */
const textToolThenRst: Scenario = {
  name: "text+tool_call-then-rst",
  respond: (_i, res, call) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(chunkFrame(call.body.model, { content: "E2E " }));
    res.write(
      chunkFrame(call.body.model, {
        tool_calls: [{ index: 0, id: "call_e2e", type: "function", function: { name: "e2e_tool", arguments: "{" } }],
      }),
    );
    rst(res, call, "rst-after-tool-call-frame");
  },
};

/** 场景 C：每次调用都在一帧文本后 RST —— 第一次触发续写，续写流再死即二次失败。 */
const rstEveryCall = (first: string, rest: string): Scenario => ({
  name: `rst-every-call(${first}|${rest})`,
  respond: (i, res, call) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(chunkFrame(call.body.model, { content: i === 0 ? first : rest }));
    rst(res, call, i === 0 ? "rst-initial" : "rst-continuation");
  },
});

/**
 * 场景 D：初始流一帧后 RST；第 2 次调用（续写创建）回真实 HTTP 429 + Retry-After 头；
 * 第 3 次起回完整正常流，验证续写创建重试及拼接。
 */
const contCreation429ThenOk = (retryAfterSeconds: number): Scenario => ({
  name: `continuation-creation-429(retry-after=${retryAfterSeconds}s)`,
  respond: (i, res, call) => {
    if (i === 0) {
      res.writeHead(200, SSE_HEADERS);
      res.write(chunkFrame(call.body.model, { content: "E2E " }));
      rst(res, call, "rst-initial");
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
          error: { message: "local mock rate limit (injected 429)", type: "rate_limit_error", code: "rate_limit_exceeded" },
        }),
      );
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(chunkFrame(call.body.model, { content: "tail ok" }));
    res.write(chunkFrame(call.body.model, {}, "stop"));
    res.end("data: [DONE]\n\n");
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
      if (req.method === "POST" && req.url === "/v1/chat/completions" && scenario) {
        scenario.respond(localCalls.length - 1, res, call);
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "local upstream: no scenario" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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
    name: "E2E Resume Local Upstream",
    baseUrl,
    apiKey: UPSTREAM_KEY,
    protocolMappings: { openai: `${baseUrl}/v1` },
    enabled: true,
  });
  const { id: modelId } = await post("/api/admin/models", {
    name: LOCAL_MODEL,
    providerId: LOCAL_PROVIDER_ID,
    modelIdentifier: LOCAL_IDENTIFIER,
    enabled: true,
  });
  await post("/api/admin/virtual-keys", {
    name: "e2e-vk-resume-local",
    modelId,
    keyType: "custom",
    customKey: LOCAL_VK,
    routingStrategy: "single",
    enabled: true,
  });
}

const localBearerHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  authorization: `Bearer ${LOCAL_VK}`,
});

/** 向网关发起流式 chat completion；marker 会进入上游请求与 request_params_json.user。 */
async function streamChat(options: {
  model: string;
  headers: Record<string, string>;
  marker: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: options.headers,
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      stream: true,
      user: options.marker,
      messages: [{ role: "user", content: options.prompt }],
    }),
  });
  return res;
}

async function waitForUpstreamAbort(call: LocalCall, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!call.clientClosed && Date.now() < deadline) await sleep(100);
  if (!call.clientClosed) {
    throw new Error("upstream never observed the gateway aborting the connection");
  }
}

let localUpstream: { baseUrl: string; close: () => Promise<void> } | null = null;

// ─── 生命周期 ─────────────────────────────────────────────────────────────────

resetJournalBeforeEach();

beforeAll(async () => {
  await adminLogin();
  localUpstream = await startLocalUpstream();
  await seedLocalUpstream(localUpstream.baseUrl);
}, 60_000);

beforeEach(async () => {
  localCalls.length = 0;
  scenario = null;
  await setUpstreamFailMode(ctx().mockBaseUrl, null);
});

afterEach(async () => {
  // one-shot 注入若未被消耗也在这里解除，避免泄漏到其他用例
  await setUpstreamFailMode(ctx().mockBaseUrl, null);
  // 恢复默认关闭（与全新网关的出厂状态一致）
  await setStreamResume(false);
});

afterAll(async () => {
  await setStreamResume(false);
  await localUpstream?.close();
});

// ─── 全局 mock upstream：断链续写 + 带内 429 ──────────────────────────────────
// 熔断器注意：这些用例共用 breaker key prov-e2e-mock::mock-gpt（阈值 2），
// 失败用例与成功用例交错排列，绝不让连续失败达到 2。

test("upstream RST mid-stream, resume disabled: terminal in-band SSE error, exactly one upstream call", async () => {
  const c = ctx();
  const marker = "resume-e2e-rst-off";
  await setStreamResume(false);
  await setUpstreamFailMode(c.mockBaseUrl, "drop-after-chunks:1");

  const res = await streamChat({
    model: c.models.openai,
    headers: bearerHeaders("openai"),
    marker,
    prompt: "e2e resume rst disabled",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const raw = await res.text();
  const frames = sseDataFrames(raw);
  expect(frames).toHaveLength(1); // 只有断链前已冲刷的首个 delta
  expect(stitchedText(raw)).toBe("E2E ");
  expect(raw).toContain("event: error"); // 头已提交 → 终态以带内 error 帧收尾
  expect(raw).not.toContain("[DONE]"); // 失败流没有 [DONE]

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(1); // 开关关闭 → 网关不发起续写
  expect(entries[0].failure).toMatchObject({
    mode: "drop-after-chunks",
    chunksWritten: 1,
    wire: "socket-destroyed",
  });
  expect((await fetchUpstreamFailMode(c.mockBaseUrl)).fired).toBe(true);

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBeTruthy();
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("upstream RST mid-stream, resume enabled: continuation carries partial text + instruction; stitch duplicates the mock's replayed prefix", async () => {
  const c = ctx();
  const marker = "resume-e2e-rst-on";
  await setStreamResume(true);
  await setUpstreamFailMode(c.mockBaseUrl, "drop-after-chunks:1");

  const res = await streamChat({
    model: c.models.openai,
    headers: bearerHeaders("openai"),
    marker,
    prompt: "e2e resume rst enabled",
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  expect(raw).not.toContain("event: error"); // 断链被续写吸收，不再向下游报错

  const frames = sseDataFrames(raw);
  expect(frames.filter((f) => f === "[DONE]")).toHaveLength(1); // 恰好一个终止帧
  expect(frames.at(-1)).toBe("[DONE]");
  // 揭示（拼接重复）：续写指令要求"不要重复已输出文本"，但 mock 无视指令原样重放
  // 全部脚本，而网关不做重叠去重 —— 客户端拿到首帧 "E2E " 两次：
  //   attempt#1: "E2E " → RST → 续写 → mock 重放 "E2E " + "openai ok"
  // 续写的正确性完全依赖上游遵守指令；本断言锁定当前真实行为。
  expect(stitchedText(raw)).toBe("E2E E2E openai ok");

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(2); // 初始请求 + 续写请求
  expect(entries[0].failure).toMatchObject({ mode: "drop-after-chunks", chunksWritten: 1, wire: "socket-destroyed" });
  expect(entries[1].failure).toBeUndefined(); // one-shot 注入已消耗，续写恢复正常

  const cont = entries[1].body as Record<string, any>;
  expect(cont.model).toBe(c.identifiers.openai); // 续写仍改写为 model_identifier
  expect(cont.stream).toBe(true);
  expect(cont.user).toBe(marker); // user 标记随续写透传，可跨 journal/DB 对账
  expect(cont.stream_options).toEqual({ include_usage: true }); // 计费所需的 usage 开关强制保留
  expect(cont.messages).toEqual([
    { role: "user", content: "e2e resume rst enabled" },
    { role: "assistant", content: "E2E " }, // 已输出文本原样回传
    { role: "user", content: RESUME_INSTRUCTION }, // 续写指令
  ]);

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("success"); // 续写成功 → 整体记成功
  expect([c.models.openai, c.identifiers.openai]).toContain(row.model);
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  expect(params.stream_resume_attempts).toBe(1);
  expect(params.stream_resume_chars).toBe("E2E ".length);
});

test("in-band SSE 429, resume disabled: terminal error frame with normalized type — upstream rate-limit semantics lost", async () => {
  const c = ctx();
  const marker = "resume-e2e-inband429-off";
  await setStreamResume(false);
  await setUpstreamFailMode(c.mockBaseUrl, "mid-stream-status:429", 2);

  const res = await streamChat({
    model: c.models.openai,
    headers: bearerHeaders("openai"),
    marker,
    prompt: "e2e inband 429 disabled",
  });
  expect(res.status).toBe(200); // 状态行已按 200 提交，无法回改成 429
  const raw = await res.text();
  expect(sseDataFrames(raw)).toHaveLength(1); // 首帧 delta
  expect(stitchedText(raw)).toBe("E2E ");
  expect(raw).toContain("event: error");
  expect(raw).not.toContain("[DONE]");

  // 揭示（语义丢失）：mock 的带内错误负载声明 type=rate_limit_error、
  // code=rate_limit_exceeded、retry_after="2"；SDK 把裸 error data 帧变成无 status 的
  // APIError，网关归一化成 500 —— 下游只剩 message 文本，type/code/retry_after 全丢。
  const errorPayload = sseErrorPayload(raw);
  expect(errorPayload.error.message).toContain("injected 429");
  expect(errorPayload.error.message).toContain("Retry after 2s");
  expect(errorPayload.error.type).toBe("api_error");
  expect(errorPayload.error).not.toHaveProperty("retry_after");

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(1);
  expect(entries[0].failure).toMatchObject({
    mode: "mid-stream-status",
    chunksWritten: 1,
    wire: "sse-error-then-end",
    status: 429,
    retryAfterSeconds: 2,
  });

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(String(row.error_message)).toContain("injected 429");
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("in-band SSE 429, resume enabled: gateway swallows the in-band error and resumes; in-band retry_after is not honored", async () => {
  const c = ctx();
  const marker = "resume-e2e-inband429-on";
  await setStreamResume(true);
  await setUpstreamFailMode(c.mockBaseUrl, "mid-stream-status:429", 2);

  const res = await streamChat({
    model: c.models.openai,
    headers: bearerHeaders("openai"),
    marker,
    prompt: "e2e inband 429 enabled",
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  // 带内 429 对下游完全不可见：网关消费了错误帧并用续写流补齐
  expect(raw).not.toContain("event: error");
  const frames = sseDataFrames(raw);
  expect(frames.filter((f) => f === "[DONE]")).toHaveLength(1);
  expect(frames.at(-1)).toBe("[DONE]");
  expect(stitchedText(raw)).toBe("E2E E2E openai ok"); // 同“拼接重复”问题

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(2);
  expect(entries[0].failure).toMatchObject({ wire: "sse-error-then-end", status: 429, retryAfterSeconds: 2 });
  expect(entries[1].failure).toBeUndefined();
  expect(((entries[1].body as Record<string, any>).messages as any[]).at(-1)).toEqual({
    role: "user",
    content: RESUME_INSTRUCTION,
  });
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("success");
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  expect(params.stream_resume_attempts).toBe(1);
  expect(params.stream_resume_chars).toBe("E2E ".length);
});

test("upstream RST before any frame, resume enabled: nothing to continue → HTTP 500 JSON, single upstream call", async () => {
  const c = ctx();
  const marker = "resume-e2e-zero-chunks";
  await setStreamResume(true);
  await setUpstreamFailMode(c.mockBaseUrl, "drop-after-chunks:0");

  const res = await streamChat({
    model: c.models.openai,
    headers: bearerHeaders("openai"),
    marker,
    prompt: "e2e zero chunks",
  });
  // 头未提交（零输出 → 网关还没写 SSE 头）→ 错误可以落成真实状态码
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type") || "").toContain("application/json");
  const body = (await res.json()) as { error: { type: string; message: string } };
  expect(body.error.type).toBe("api_error");
  expect(body.error.message).toBeTruthy();

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(1); // 零输出 → 无可续写内容，不发起续写
  expect(entries[0].failure).toMatchObject({ mode: "drop-after-chunks", chunksWritten: 0, wire: "socket-destroyed" });

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

// ─── local upstream：abort / tool-call / 续写创建 429+Retry-After / 二次失败 ────
// 熔断器注意（key prov-e2e-resume-local::mock-gpt-resume）：tool 用例（失败）
// → 429 重试用例（成功）→ 二次失败用例（失败），同样不触发连续 2 次失败。

test("client abort mid-stream (resume enabled): no continuation, gateway aborts upstream, 'Client aborted' error row", async () => {
  const marker = "resume-e2e-abort";
  await setStreamResume(true);
  setScenario(stallAfterFirstFrame);

  const ac = new AbortController();
  const res = await streamChat({
    model: LOCAL_MODEL,
    headers: localBearerHeaders(),
    marker,
    prompt: "e2e client abort",
    signal: ac.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  // 确定性窗口：上游停帧 → 客户端读到首帧后 abort
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
  expect(localCalls[0].body.model).toBe(LOCAL_IDENTIFIER);
  expect(localCalls[0].authorization).toBe(`Bearer ${UPSTREAM_KEY}`);

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBe("Client aborted"); // 字面量契约（utils/client-abort.ts）
  expect([LOCAL_MODEL, LOCAL_IDENTIFIER]).toContain(row.model);
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("tool_call delta already flushed (resume enabled): non-text deltas are not resumable — terminal, one upstream call", async () => {
  const marker = "resume-e2e-tool";
  await setStreamResume(true);
  setScenario(textToolThenRst);

  const res = await streamChat({
    model: LOCAL_MODEL,
    headers: localBearerHeaders(),
    marker,
    prompt: "e2e tool call no resume",
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const frames = sseDataFrames(raw);
  expect(frames).toHaveLength(2); // 文本帧 + tool_call 增量帧都已被冲刷
  const toolDelta = JSON.parse(frames[1]).choices[0].delta;
  expect(toolDelta.tool_calls).toBeDefined();
  expect(raw).toContain("event: error"); // 终态带内错误
  expect(raw).not.toContain("[DONE]");

  expect(localCalls).toHaveLength(1); // sawNonTextDelta → 不发起续写
  expect(localCalls[0].failure).toMatchObject({ kind: "rst-after-tool-call-frame" });

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});

test("continuation creation rejected with HTTP 429: gateway retries and stitches", async () => {
  const marker = "resume-e2e-cont429";
  const retryAfterSeconds = 1;
  await setStreamResume(true);
  setScenario(contCreation429ThenOk(retryAfterSeconds));

  const res = await streamChat({
    model: LOCAL_MODEL,
    headers: localBearerHeaders(),
    marker,
    prompt: "e2e continuation creation 429",
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  expect(raw).not.toContain("event: error");
  const frames = sseDataFrames(raw);
  expect(frames.filter((f) => f === "[DONE]")).toHaveLength(1);
  expect(frames.at(-1)).toBe("[DONE]");
  // local upstream 的续写段不再重复前缀（可控脚本）：拼接正是"部分文本 + 续写文本"
  expect(stitchedText(raw)).toBe("E2E tail ok");
  // 初始请求 + 被拒的续写创建 + 重试成功的续写
  expect(localCalls).toHaveLength(3);
  expect(localCalls[0].failure).toMatchObject({ kind: "rst-initial" });
  expect(localCalls[1].failure).toMatchObject({ kind: "creation-rejected-429", retryAfterSeconds });
  expect(localCalls[2].failure).toBeUndefined();
  // 两次续写创建的请求体一致（同一部分文本 + 指令）
  expect((localCalls[1].body as Record<string, any>).messages).toEqual([
    { role: "user", content: "e2e continuation creation 429" },
    { role: "assistant", content: "E2E " },
    { role: "user", content: RESUME_INSTRUCTION },
  ]);
  expect((localCalls[2].body as Record<string, any>).messages).toEqual(
    (localCalls[1].body as Record<string, any>).messages,
  );

  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("success");
  const params = paramsOf(row);
  expect(params.stream_resumed).toBe(true);
  // 创建次数口径：被 429 拒绝的创建 + Retry-After 后重试成功的创建（初始请求
  // 不计），与 journal（localCalls 续写调用次数）逐次对账；仍只采纳一段续写。
  expect(params.stream_resume_attempts).toBe(2);
  expect(params.stream_resume_attempts).toBe(localCalls.length - 1);
  expect(params.stream_resume_chars).toBe("E2E ".length);
});

test("second upstream failure after a resume was adopted is terminal: exactly one continuation segment", async () => {
  const marker = "resume-e2e-second-fail";
  await setStreamResume(true);
  setScenario(rstEveryCall("E2E ", "again "));

  const res = await streamChat({
    model: LOCAL_MODEL,
    headers: localBearerHeaders(),
    marker,
    prompt: "e2e second failure terminal",
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const frames = sseDataFrames(raw);
  expect(frames).toHaveLength(2); // 初始段 "E2E " + 续写段 "again " 都已冲刷
  expect(stitchedText(raw)).toBe("E2E again ");
  expect(raw).toContain("event: error"); // 续写段再死 → 终态，不再续
  expect(raw).not.toContain("[DONE]");

  expect(localCalls).toHaveLength(2); // 初始 + 唯一一段续写
  expect((localCalls[1].body as Record<string, any>).messages).toEqual([
    { role: "user", content: "e2e second failure terminal" },
    { role: "assistant", content: "E2E " },
    { role: "user", content: RESUME_INSTRUCTION },
  ]);
  expect(localCalls[1].failure).toMatchObject({ kind: "rst-continuation" });

  // 错误路径的落库行从不携带续写标记（error 分支不传 streamResume）
  const row = await pollRowByUserMarker(marker);
  expect(row.status).toBe("error");
  expect(row.error_message).toBeTruthy();
  expect(paramsOf(row).stream_resumed).toBeUndefined();
});
