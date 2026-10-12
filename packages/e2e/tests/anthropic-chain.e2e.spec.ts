import { expect, test } from "vitest";
import { ctx, journalOf, nativeKeyHeader, pollApiRequestRow, upstreamAuthValue, resetJournalBeforeEach } from "./helpers.js";

resetJournalBeforeEach();

test("anthropic non-stream: /v1/messages forwards natively with x-api-key auth", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/messages`, {
    method: "POST",
    headers: nativeKeyHeader("x-api-key", "anthropic"),
    body: JSON.stringify({
      model: c.models.anthropic,
      max_tokens: 64,
      messages: [{ role: "user", content: "e2e ping" }],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    type: string;
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
  expect(body.type).toBe("message");
  expect(body.content[0]?.text).toBe("E2E anthropic ok");
  expect(body.usage.input_tokens).toBe(11);

  const entries = await journalOf("anthropic");
  expect(entries).toHaveLength(1);
  expect(entries[0].path).toBe("/v1/messages");
  // anthropic 原生转发把网关侧模型名改写为 model_identifier
  expect((entries[0].body as { model?: string }).model).toBe(c.identifiers.anthropic);
  expect(upstreamAuthValue(entries[0])).toBe("e2e-upstream-key");

  const row = await pollApiRequestRow(c.mysql, (r) => r.model === c.models.anthropic || r.model === c.identifiers.anthropic);
  expect(row.status).toBe("success");
  expect(Number(row.prompt_tokens)).toBe(11);
  expect(Number(row.completion_tokens)).toBe(7);
});

test("anthropic stream: content_block_delta events reassemble into the text", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/messages`, {
    method: "POST",
    headers: nativeKeyHeader("x-api-key", "anthropic"),
    body: JSON.stringify({
      model: c.models.anthropic,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "e2e stream" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const text = await res.text();
  expect(text).toContain("event: message_start");
  expect(text).toContain("event: message_stop");
  const deltas = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as { type?: string; delta?: { text?: string } })
    .filter((j) => j.type === "content_block_delta")
    .map((j) => j.delta?.text ?? "")
    .join("");
  expect(deltas).toBe("E2E anthropic ok");
  expect(await journalOf("anthropic")).toHaveLength(1);
});
