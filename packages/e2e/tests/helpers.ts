import { beforeEach } from "vitest";
import { loadContext, type E2EContext } from "../src/helpers/context.js";
import { fetchJournal, resetJournal, setJevFailMode, type JournalEntry } from "../src/helpers/mock-upstream.js";
import { pollApiRequestRow } from "../src/helpers/db.js";

let cached: E2EContext | null = null;

export function ctx(): E2EContext {
  if (!cached) cached = loadContext(process.env.E2E_CONTEXT_FILE);
  return cached;
}

export function resetJournalBeforeEach(): void {
  beforeEach(async () => {
    await resetJournal(ctx().mockBaseUrl);
  });
}

export function journal(): Promise<JournalEntry[]> {
  return fetchJournal(ctx().mockBaseUrl);
}

export function journalOf(kind: JournalEntry["kind"]): Promise<JournalEntry[]> {
  return journal().then((all) => all.filter((e) => e.kind === kind));
}

export function bearerHeaders(chain: "openai" | "expert"): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${virtualKeyFor(chain)}` };
}

/** Anthropic 客户端用 x-api-key，Gemini 客户端用 x-goog-api-key；网关均应识别为虚拟密钥。 */
export function nativeKeyHeader(name: "x-api-key" | "x-goog-api-key", chain: "anthropic" | "gemini"): Record<string, string> {
  return { "content-type": "application/json", [name]: virtualKeyFor(chain) };
}

function virtualKeyFor(chain: "openai" | "anthropic" | "gemini" | "expert"): string {
  const c = ctx();
  const model = chain === "expert" ? c.expertVirtualModel : c.models[chain];
  const key = c.virtualKeys[model];
  if (!key) throw new Error(`no virtual key seeded for ${chain} (model ${model})`);
  return key;
}

/** 上游收到的鉴权值（三种原生协议头取其一，Bearer 前缀去掉后比较）。 */
export function upstreamAuthValue(e: JournalEntry): string | null {
  const raw = e.authorization ?? e.xApiKey ?? e.xGoogApiKey;
  return raw === null ? null : raw.replace(/^Bearer /, "");
}

/** SSE 文本 → data: 载荷列表（保留 [DONE] 原文）。 */
export function sseDataPayloads(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
}

export { pollApiRequestRow, setJevFailMode };
