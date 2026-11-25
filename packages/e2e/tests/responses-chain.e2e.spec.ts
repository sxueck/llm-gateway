import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { bearerHeaders, ctx, journalOf, pollApiRequestRow, resetJournalBeforeEach, upstreamAuthValue } from "./helpers.js";

resetJournalBeforeEach();

const instructions = "Keep the e2e answer short.";

function requestResponse(input: string | Array<{ role: string; content: string }>, user: string, stream?: false) {
  const c = ctx();
  return fetch(`${c.gatewayBaseUrl}/v1/responses`, {
    method: "POST",
    headers: bearerHeaders("openai"),
    body: JSON.stringify({ model: c.models.openai, input, instructions, user, stream }),
  });
}

function auditRowFor(marker: string) {
  return pollApiRequestRow(ctx().mysql, (row) => {
    const params = typeof row.request_params_json === "string"
      ? JSON.parse(row.request_params_json)
      : row.request_params_json;
    return (params as { user?: string } | null)?.user === marker;
  });
}

test.each([
  { mode: "omitted stream", stream: undefined, input: "e2e responses ping" },
  { mode: "explicit stream: false", stream: false as const, input: [{ role: "user", content: "e2e responses message" }] },
])("responses non-stream ($mode) preserves the native response and audits usage", async ({ input, stream }) => {
  const marker = `responses-${randomUUID()}`;
  const res = await requestResponse(input, marker, stream);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("x-upstream-request-id")).toBe("req-e2e-responses");
  expect(await res.json()).toMatchObject({
    id: "resp-e2e",
    object: "response",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "E2E responses ok" }] }],
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
  });

  const entries = await journalOf("openai");
  expect(entries).toHaveLength(1);
  expect(entries[0].path).toBe("/v1/responses");
  expect(upstreamAuthValue(entries[0])).toBe("e2e-upstream-key");
  expect(entries[0].body).toMatchObject({ model: ctx().identifiers.openai, input, instructions, stream: false });

  const row = await auditRowFor(marker);
  expect(row.status).toBe("success");
  expect(Number(row.prompt_tokens)).toBe(12);
  expect(Number(row.completion_tokens)).toBe(5);
});

test("responses non-stream preserves an HTTP 200 failed response and audits it as an error", async () => {
  const marker = `responses-failed-${randomUUID()}`;
  const res = await requestResponse("e2e responses failed", marker, false);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    object: "response",
    status: "failed",
    output: [],
    error: { code: "server_error", message: "E2E responses failed" },
  });
  expect((await auditRowFor(marker)).status).toBe("error");
});
