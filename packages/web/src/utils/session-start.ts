/**
 * 会话首条判定（启发式）：客户端每轮重发全量历史，请求体内不含 assistant/model
 * 回合即视为该 session 的第一次请求。仅覆盖 OpenAI messages 与 Gemini contents
 * 两种形状；请求体缺失、解析失败或不含消息数组时不判定（不标记）。
 */
export function isSessionStartBody(
  requestBody: string | null | undefined,
): boolean {
  if (!requestBody) return false;
  try {
    const parsed = JSON.parse(requestBody);
    const messages = parsed?.messages ?? parsed?.contents;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    return !messages.some(
      (m: any) => m?.role === "assistant" || m?.role === "model",
    );
  } catch {
    return false;
  }
}
