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
