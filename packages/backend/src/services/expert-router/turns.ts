/**
 * Continuation-turn detection (PRD §5.2). Agent loops send tool results and
 * assistant continuations as follow-up turns; these must reuse the previous
 * routing decision instead of re-classifying — saves classifier latency and
 * avoids switching models mid tool loop.
 */

interface ContinuationBody {
  messages?: any[];
  input?: any;
  contents?: any[];
}

function lastMessageOf(messages: any[]): any | undefined {
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

/** OpenAI chat: trailing `tool` role messages are tool results. */
function isOpenAiToolResultTurn(messages: any[]): boolean {
  const last = lastMessageOf(messages);
  return Boolean(last && last.role === "tool");
}

/** Trailing assistant message = agent continuation (prefill/stream resume). */
function isAssistantContinuation(messages: any[]): boolean {
  const last = lastMessageOf(messages);
  return Boolean(last && last.role === "assistant");
}

/** Anthropic messages: a trailing user message whose content is entirely
 *  tool_result blocks (content may be a single object or an array). */
function isAnthropicToolResultTurn(messages: any[]): boolean {
  const last = lastMessageOf(messages);
  if (!last || last.role !== "user") return false;
  const content = last.content;
  if (Array.isArray(content)) {
    return (
      content.length > 0 &&
      content.every(
        (block: any) => block && typeof block === "object" && block.type === "tool_result",
      )
    );
  }
  return Boolean(
    content && typeof content === "object" && content.type === "tool_result",
  );
}

/** Responses API: trailing function_call_output / custom_tool_call_output items. */
function isResponsesToolOutputTurn(input: any): boolean {
  if (!Array.isArray(input) || input.length === 0) return false;
  const last = input[input.length - 1];
  return Boolean(
    last &&
    typeof last === "object" &&
    (last.type === "function_call_output" || last.type === "custom_tool_call_output"),
  );
}

/** Gemini native: trailing model-role turn. */
function isGeminiModelTurn(contents: any[]): boolean {
  const last = lastMessageOf(contents);
  return Boolean(last && last.role === "model");
}

/**
 * True when the request is an agent-loop continuation (tool result or
 * assistant follow-up) rather than a fresh user turn.
 */
export function isContinuationTurn(body: ContinuationBody | undefined | null): boolean {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return (
      isOpenAiToolResultTurn(body.messages) ||
      isAssistantContinuation(body.messages) ||
      isAnthropicToolResultTurn(body.messages)
    );
  }
  if (body.input !== undefined && body.input !== null) {
    return isResponsesToolOutputTurn(body.input);
  }
  if (Array.isArray(body.contents) && body.contents.length > 0) {
    return isGeminiModelTurn(body.contents);
  }
  return false;
}
