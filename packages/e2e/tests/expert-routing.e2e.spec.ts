import { expect, test } from "vitest";
import { bearerHeaders, ctx, journalOf, pollApiRequestRow, resetJournalBeforeEach, setJevFailMode } from "./helpers.js";

resetJournalBeforeEach();

test("expert routing: classifier (jev) picks the medium expert and the row records the tier", async () => {
  const c = ctx();
  const res = await fetch(`${c.gatewayBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: bearerHeaders("expert"),
    body: JSON.stringify({ model: c.expertVirtualModel, messages: [{ role: "user", content: "classify me" }] }),
  });
  expect(res.status).toBe(200);

  // classifier 被真实调用过一次
  const jevEntries = await journalOf("jev");
  expect(jevEntries.length).toBeGreaterThanOrEqual(1);

  // medium 档专家模型被命中（mock 固定返回 choice=medium）
  const openaiEntries = await journalOf("openai");
  expect(openaiEntries).toHaveLength(1);
  expect((openaiEntries[0].body as { model?: string }).model).toBe(c.expertUpstreamModels.medium);

  const row = await pollApiRequestRow(
    c.mysql,
    (r) => r.model === c.expertUpstreamModels.medium && r.route_tier === "medium",
  );
  expect(row.status).toBe("success");
  expect(row.route_log_id).not.toBeNull();
});

test("expert routing fail_open=fallback: classifier outage routes to the low band expert, not the fallback", async () => {
  const c = ctx();
  await setJevFailMode(c.mockBaseUrl, true);
  try {
    const res = await fetch(`${c.gatewayBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: bearerHeaders("expert"),
      body: JSON.stringify({
        model: c.expertVirtualModel,
        messages: [{ role: "user", content: "during outage" }],
      }),
    });
    expect(res.status).toBe(200);

    const entries = await journalOf("openai");
    expect(entries).toHaveLength(1);
    // 产品语义：classifier 不可达时 fail_open 选最低档（low）而非 fallback 专家
    expect((entries[0].body as { model?: string }).model).toBe(c.expertUpstreamModels.low);
  } finally {
    await setJevFailMode(c.mockBaseUrl, false);
  }
});
