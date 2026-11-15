import { afterAll, afterEach, expect, test } from "vitest";
import {
  fetchJournal,
  fetchUpstreamFailMode,
  resetJournal,
  setUpstreamFailMode,
  startMockUpstream,
  type ServerHandle,
} from "../src/helpers/mock-upstream.js";

/**
 * mock-upstream helper 的独立测试：不起网关、不碰 MySQL，
 * 直接对着自己的 mock 实例（临时端口）验证 /_internal/upstream-fail-mode 的
 * 语义、one-shot 行为、journal 记录以及 HTTP 协议限制的落地表现。
 */

const server: ServerHandle = await startMockUpstream();

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  // 既有约定：journal 用 reset 端点清；注入状态显式置 null 清
  await setUpstreamFailMode(server.baseUrl, null);
  await resetJournal(server.baseUrl);
});

function post(body: unknown, path = "/v1/chat/completions"): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamReq(messages: Array<{ role: string; content: string }> = [{ role: "user", content: "hi" }]): Promise<Response> {
  return post({ model: "mock-gpt", stream: true, messages });
}

test("fail-mode 参数校验：非法 mode / 非法 Retry-After 一律 400 快速失败", async () => {
  await expect(setUpstreamFailMode(server.baseUrl, "drop-after-chunks:x")).rejects.toThrow(/unknown fail mode/);
  await expect(setUpstreamFailMode(server.baseUrl, "drop-after-chunks:-1")).rejects.toThrow(/unknown fail mode/);
  await expect(setUpstreamFailMode(server.baseUrl, "mid-stream-status:302")).rejects.toThrow(/400-599/);
  await expect(setUpstreamFailMode(server.baseUrl, "drop-after-chunks:1", 5)).rejects.toThrow(
    /retryAfterSeconds is only valid with mid-stream-status/,
  );
  await expect(setUpstreamFailMode(server.baseUrl, "mid-stream-status:429", 1.5)).rejects.toThrow(
    /non-negative integer/,
  );
});

test("drop-after-chunks:1：写完首帧后 RST 断链，journal 记 socket-destroyed，且 one-shot 解除", async () => {
  await setUpstreamFailMode(server.baseUrl, "drop-after-chunks:1");

  const res = await streamReq();
  // 头已提交（200 + SSE），随后传输层被掐断——读 body 必然失败
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");
  await expect(res.text()).rejects.toThrow();

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.kind).toBe("openai");
  expect(entry.failure).toMatchObject({ mode: "drop-after-chunks", chunksWritten: 1, wire: "socket-destroyed" });

  const view = await fetchUpstreamFailMode(server.baseUrl);
  expect(view.spec).toBeNull();
  expect(view.fired).toBe(true);
});

test("drop-after-chunks 的 one-shot 保证“首请求失败、续写请求正常”", async () => {
  await setUpstreamFailMode(server.baseUrl, "drop-after-chunks:1");

  // 首请求：中断
  const first = await streamReq([{ role: "user", content: "tell me a story" }]);
  await expect(first.text()).rejects.toThrow();

  // 模拟网关断点续写请求：原始消息 + 已输出的 assistant 半截 + 续写指令（buildResumeMessages 形态）
  const continuation = await streamReq([
    { role: "user", content: "tell me a story" },
    { role: "assistant", content: "E2E " },
    { role: "user", content: "Continue that reply exactly from where it stopped." },
  ]);
  expect(continuation.status).toBe(200);
  const text = await continuation.text();
  expect(text).toContain("E2E ");
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

  const entries = await fetchJournal(server.baseUrl);
  expect(entries).toHaveLength(2);
  expect(entries[0].failure?.wire).toBe("socket-destroyed");
  expect(entries[1].failure).toBeUndefined();
});

test("mid-stream-status:429 流式：状态行已是 200 无法更改，错误语义只能带内传达", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429");

  const res = await streamReq();
  expect(res.status).toBe(200); // 协议限制：状态行已提交，不能变成 429
  expect(res.headers.get("retry-after")).toBeNull(); // 头发不出去，这是硬限制
  const text = await res.text(); // 干净收尾，body 可完整读取

  expect(text).toContain("E2E "); // 首帧先正常送达（流确实开始了）
  expect(text).toContain('"type":"rate_limit_error"'); // 带内 error 事件承载 429 语义
  expect(text).not.toContain("data: [DONE]"); // 终止帧不再出现

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.failure).toMatchObject({
    mode: "mid-stream-status",
    status: 429,
    chunksWritten: 1,
    wire: "sse-error-then-end",
  });
});

test("mid-stream-status:429 流式带 retryAfterSeconds：退避值只能并入事件负载", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429", 7);

  const res = await streamReq();
  expect(res.status).toBe(200);
  expect(res.headers.get("retry-after")).toBeNull(); // HTTP 头通道不可用
  const text = await res.text();
  expect(text).toContain('"retry_after":"7"'); // 带内代偿通道

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.failure).toMatchObject({ status: 429, retryAfterSeconds: 7, wire: "sse-error-then-end" });
});

test("mid-stream-status:429 非流式：响应头未提交，返回真实 429 + 真实 Retry-After 头", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429", 3);

  const res = await post({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("3");
  const body = (await res.json()) as { error: { type: string; code: string } };
  expect(body.error.type).toBe("rate_limit_error");
  expect(body.error.code).toBe("rate_limit_exceeded");

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.failure).toMatchObject({
    mode: "mid-stream-status",
    status: 429,
    retryAfterSeconds: 3,
    wire: "http-status",
  });
});

test("mid-stream-status:429 在 anthropic 流式方言里带 event: error 帧", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429");

  const res = await post({ model: "mock-claude", stream: true, messages: [{ role: "user", content: "hi" }] }, "/v1/messages");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: error");
  expect(text).toContain('"type":"rate_limit_error"');
  expect(text).not.toContain("event: message_stop");

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.kind).toBe("anthropic");
  expect(entry.failure?.wire).toBe("sse-error-then-end");
});

test("drop-after-chunks 只对流式生效：armed 状态下非流式请求正常且不消耗注入", async () => {
  await setUpstreamFailMode(server.baseUrl, "drop-after-chunks:1");

  const res = await post({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0]?.message.content).toBe("E2E openai ok");

  const view = await fetchUpstreamFailMode(server.baseUrl);
  expect(view.spec).toEqual({ mode: "drop-after-chunks", chunks: 1 });
  expect(view.fired).toBe(false);
});

test("注入不影响 /jev 分类器（它有自己的 jev-fail-mode）", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429");

  const res = await post({ model: "mock-gpt" }, "/jev");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { answers: { model: { choice: string } } };
  expect(body.answers.model.choice).toBe("medium");

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.kind).toBe("jev");
  expect(entry.failure).toBeUndefined();
  // 也没有被 /jev 消耗掉
  const view = await fetchUpstreamFailMode(server.baseUrl);
  expect(view.fired).toBe(false);
});

test("显式清除：mode=null 恢复正常流，fired 复位", async () => {
  await setUpstreamFailMode(server.baseUrl, "mid-stream-status:429");
  await setUpstreamFailMode(server.baseUrl, null);

  const res = await streamReq();
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('"openai ok"'); // 正常双帧 delta 完整送达
  expect(text).not.toContain("rate_limit_error");

  const [entry] = await fetchJournal(server.baseUrl);
  expect(entry.failure).toBeUndefined();
  const view = await fetchUpstreamFailMode(server.baseUrl);
  expect(view.spec).toBeNull();
  expect(view.fired).toBe(false);
});
