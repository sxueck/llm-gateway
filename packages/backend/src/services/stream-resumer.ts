import { systemConfigDb } from "../db/index.js";
import { memoryLogger } from "./logger.js";

export const STREAM_RESUME_ENABLED_CONFIG_KEY = "stream_resume_enabled";

export const STREAM_RESUME_INSTRUCTION =
  "Your previous reply was cut off by a transient network error right after the assistant text above. " +
  "Continue that reply exactly from where it stopped. " +
  "Do not repeat, rephrase, or summarize text you already output, and do not mention the interruption.";

/**
 * Build the continuation messages for stream resume using the standard OpenAI
 * chat-completions shape: original conversation + partial assistant text as a
 * trailing assistant message + an explicit continue instruction. The final
 * downstream reply is the concatenation of the partial text and the
 * continuation — callers do not need to stitch anything.
 */
export function buildResumeMessages(
  originalMessages: any[],
  partialText: string,
): any[] {
  return [
    ...originalMessages,
    { role: "assistant", content: partialText },
    { role: "user", content: STREAM_RESUME_INSTRUCTION },
  ];
}

/**
 * Build the continuation `input` for a Responses API stream resume: original
 * input items + the partial assistant text as an assistant message (output_text
 * part, matching the Responses input schema) + the explicit continue
 * instruction. A string input is normalized to a single user message item.
 */
export function buildResumeResponsesInput(
  originalInput: string | any[] | undefined,
  partialText: string,
): any[] {
  const baseItems: any[] =
    typeof originalInput === "string"
      ? [{ role: "user", content: originalInput }]
      : Array.isArray(originalInput)
        ? [...originalInput]
        : [];

  return [
    ...baseItems,
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: partialText }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: STREAM_RESUME_INSTRUCTION }],
    },
  ];
}

/** Tool-related params stripped from the continuation request: the gateway
 * can only stitch plain text, so a resumed turn must never emit tool calls. */
const RESPONSES_RESUME_TOOL_KEYS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tool_calls",
  "mcp",
  "tool_search",
] as const;

/**
 * Build the continuation request params for a Responses API stream resume.
 * Keeps the original passthrough params (model, instructions, reasoning,
 * previous_response_id, …) with tool calling disabled and the input replaced
 * by buildResumeResponsesInput.
 */
export function buildResumeResponsesParams(
  originalParams: any,
  partialText: string,
): any {
  const resumeParams: any = { ...originalParams };
  for (const key of RESPONSES_RESUME_TOOL_KEYS) {
    delete resumeParams[key];
  }
  resumeParams.input = buildResumeResponsesInput(originalParams?.input, partialText);
  resumeParams.tool_choice = "none";
  resumeParams.stream = true;
  return resumeParams;
}

/**
 * Lazy setting check — only invoked on the upstream mid-stream error path, so
 * the hot path pays no DB read. Off by default.
 */
export async function isStreamResumeEnabled(): Promise<boolean> {
  try {
    const cfg = await systemConfigDb.get(STREAM_RESUME_ENABLED_CONFIG_KEY);
    return cfg?.value === "true";
  } catch (e) {
    memoryLogger.debug(
      `断点续传配置读取失败，按禁用处理: ${(e as Error)?.message || e}`,
      "Proxy",
    );
    return false;
  }
}

/** Anything the OpenAI SDK error shape offers for header lookup:
 * APIError.headers is a fetch Headers instance; tolerate plain records too. */
type HeaderLookup = { get: (name: string) => string | null };

function asHeaderLookup(headers: any): HeaderLookup | null {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") return headers as HeaderLookup;
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") lower[key.toLowerCase()] = value;
  }
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

/**
 * Parse one Retry-After value: delay-seconds (decimals tolerated, as in the
 * OpenAI SDK) or an HTTP-date. Returns the delay in ms, or undefined when the
 * value is absent/invalid/negative. No fabrication: nothing is invented
 * when the header cannot be read.
 */
export function parseRetryAfterMs(
  raw: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = raw.trim();

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const ms = date - now;
  return Math.max(0, ms);
}

/**
 * Extract an upstream-advised wait from a caught continuation-request error.
 * The OpenAI SDK (maxRetries=0 here) throws APIError with a Headers instance,
 * so `retry-after` / `retry-after-ms` are genuinely available when the server
 * sent them. Prefers `retry-after-ms`, then `retry-after`. Returns undefined when no usable header
 * exists — callers then apply their own small backoff.
 */
export function extractResumeRetryAfterMs(
  error: any,
  now: number = Date.now(),
): number | undefined {
  const lookup = asHeaderLookup((error as any)?.headers);
  if (!lookup) return undefined;

  // Non-standard but explicit; same precedence as the OpenAI SDK.
  const retryAfterMsHeader = lookup.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const ms = Number.parseFloat(retryAfterMsHeader);
    if (Number.isFinite(ms) && ms >= 0) {
      return Math.round(ms);
    }
  }

  const parsed = parseRetryAfterMs(lookup.get("retry-after"), now);
  if (parsed === undefined) return undefined;
  return parsed;
}

const RETRYABLE_RESUME_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

/**
 * Whether a failed continuation-request creation is worth retrying. Mirrors
 * the SDK's shouldRetry(): 408/409/429/5xx, an explicit x-should-retry: true
 * header, or connection-level errors that never got a response.
 */
export function isRetryableResumeError(error: any): boolean {
  if (!error) return false;

  const lookup = asHeaderLookup((error as any)?.headers);
  if (lookup?.get("x-should-retry") === "true") return true;
  if (lookup?.get("x-should-retry") === "false") return false;

  const status = typeof error.status === "number" ? error.status : undefined;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;

  return RETRYABLE_RESUME_ERROR_NAMES.has(String(error.name));
}
