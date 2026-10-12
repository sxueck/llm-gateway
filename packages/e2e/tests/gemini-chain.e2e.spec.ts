import { expect, test } from "vitest";
import { ctx, journalOf, nativeKeyHeader, pollApiRequestRow, upstreamAuthValue, resetJournalBeforeEach } from "./helpers.js";

resetJournalBeforeEach();

test("gemini non-stream: /v1beta/models/{model}:generateContent forwards with x-goog-api-key auth", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1beta/models/${c.models.gemini}:generateContent`, {
    method: "POST",
    headers: nativeKeyHeader("x-goog-api-key", "gemini"),
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "e2e ping" }] }] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { totalTokenCount: number };
  };
  expect(body.candidates[0]?.content.parts[0]?.text).toBe("E2E gemini ok");
  expect(body.usageMetadata?.totalTokenCount).toBe(13);

  const entries = await journalOf("gemini");
  expect(entries).toHaveLength(1);
  // gemini 原生转发用 model_identifier 拼上游路径（网关名或标识符二选一，取决协议实现）
  expect(entries[0].path).toContain("generateContent");
  expect(
    entries[0].path.includes(`${c.identifiers.gemini}:`) || entries[0].path.includes(`${c.models.gemini}:`),
  ).toBe(true);
  expect(upstreamAuthValue(entries[0])).toBe("e2e-upstream-key");

  const row = await pollApiRequestRow(
    c.mysql,
    (r) => r.model === c.models.gemini || r.model === c.identifiers.gemini,
  );
  expect(row.status).toBe("success");
  expect(Number(row.prompt_tokens)).toBe(9);
  expect(Number(row.completion_tokens)).toBe(4);
});

test("gemini stream: alt=sse chunks reassemble", async () => {
  const c = ctx();
  const res = await fetch(
    `${c.gatewayBaseUrl}/v1beta/models/${c.models.gemini}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: nativeKeyHeader("x-goog-api-key", "gemini"),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "e2e stream" }] }] }),
    },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") || "").toContain("text/event-stream");

  const text = await res.text();
  const chunks = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()) as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> })
    .map((j) => j.candidates?.[0]?.content.parts.map((p) => p.text).join("") ?? "")
    .join("");
  expect(chunks).toBe("E2E gemini ok");
  expect(await journalOf("gemini")).toHaveLength(1);
});
