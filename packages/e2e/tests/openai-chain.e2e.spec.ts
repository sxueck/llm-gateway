import { expect, test } from "vitest";
import { bearerHeaders, ctx, journalOf, pollApiRequestRow, resetJournalBeforeEach, sseDataPayloads, upstreamAuthValue } from "./helpers.js";

resetJournalBeforeEach();

test("openai non-stream: /v1/chat/completions forwards to the mapped upstream model", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: bearerHeaders("openai"),
    body: JSON.stringify({ model: c.models.openai, messages: [{ role: "user", content: "e2e ping" }] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
  };
  expect(body.choices[0]?.message.content).toBe("E2E openai ok");
  expect(body.usage?.total_tokens).toBe(17);

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(1);
  // VK 按模型绑定时，转发体改写为该模型的 model_identifier
  expect((entries[0].body as { model?: string }).model).toBe(c.identifiers.openai);
  expect(upstreamAuthValue(entries[0])).toBe("e2e-upstream-key");

  const row = await pollApiRequestRow(
    c.mysql,
    (r) => r.model === c.models.openai || r.model === c.identifiers.openai,
  );
  expect(row.status).toBe("success");
  expect(Number(row.prompt_tokens)).toBe(12);
  expect(Number(row.completion_tokens)).toBe(5);
});

test("openai stream: SSE deltas round-trip and [DONE] terminates", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: bearerHeaders("openai"),
    body: JSON.stringify({
      model: c.models.openai,
      stream: true,
      messages: [{ role: "user", content: "e2e stream" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const payloads = sseDataPayloads(await res.text());
  expect(payloads.at(-1)).toBe("[DONE]");
  const deltas = payloads
    .slice(0, -1)
    .map((p) => JSON.parse(p) as { choices: Array<{ delta: { content?: string } }> })
    .map((j) => j.choices[0]?.delta.content ?? "")
    .join("");
  expect(deltas).toBe("E2E openai ok");
  expect(await journalOf("openai")).toHaveLength(1);
});
