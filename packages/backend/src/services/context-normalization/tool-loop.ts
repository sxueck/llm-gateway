import type { NormalizationProtocol } from './fingerprint.js';

/**
 * Detect an unfinished tool loop at the history tail (FR-13). Returns true when
 * the last tool-carrying assistant/model turn has at least one call without a
 * matching result/output following it. Protocol-aware because each protocol
 * encodes tool calls and results differently.
 */
export function detectUnfinishedToolLoop(protocol: NormalizationProtocol, body: any): boolean {
  if (!body) return false;

  switch (protocol) {
    case 'openai':
      return Array.isArray(body.input)
        ? detectResponsesUnfinished(body.input)
        : detectOpenAiChatUnfinished(body.messages);
    case 'anthropic':
      return detectAnthropicUnfinished(body.messages);
    case 'gemini':
      return detectGeminiUnfinished(body.contents);
    default:
      return false;
  }
}

function detectOpenAiChatUnfinished(messages: any[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;

  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return false;

  const callIds = new Set<string>(
    messages[lastIdx].tool_calls
      .map((c: any) => c?.id)
      .filter((id: any) => id != null) as string[]
  );
  if (callIds.size === 0) return false;

  const answered = new Set<string>();
  for (let i = lastIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === 'tool' && msg.tool_call_id != null) {
      answered.add(msg.tool_call_id);
    }
  }

  for (const id of callIds) {
    if (!answered.has(id)) return true;
  }
  return false;
}

function detectResponsesUnfinished(input: any[] | undefined): boolean {
  if (!Array.isArray(input)) return false;

  let lastCallIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type === 'function_call' && item.call_id != null) {
      lastCallIdx = i;
      break;
    }
  }
  if (lastCallIdx === -1) return false;

  let batchStart = lastCallIdx;
  for (let i = lastCallIdx - 1; i >= 0; i--) {
    const type = input[i]?.type;
    if (type === 'function_call') {
      batchStart = i;
      continue;
    }
    if (type === 'reasoning') continue;
    break;
  }

  const callIds = new Set<string>();
  for (let i = batchStart; i <= lastCallIdx; i++) {
    const item = input[i];
    if (item?.type === 'function_call' && item.call_id != null) {
      callIds.add(item.call_id);
    }
  }

  const answered = new Set<string>();
  for (let i = lastCallIdx + 1; i < input.length; i++) {
    const item = input[i];
    if (item?.type === 'function_call_output' && item.call_id != null) {
      answered.add(item.call_id);
    }
  }

  for (const id of callIds) {
    if (!answered.has(id)) return true;
  }
  return false;
}

function detectAnthropicUnfinished(messages: any[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;

  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some((b: any) => b?.type === 'tool_use');
      if (hasToolUse) {
        lastIdx = i;
        break;
      }
    }
  }
  if (lastIdx === -1) return false;

  const callIds = new Set<string>();
  for (const block of messages[lastIdx].content) {
    if (block?.type === 'tool_use' && block.id != null) callIds.add(block.id);
  }
  if (callIds.size === 0) return false;

  const answered = new Set<string>();
  for (let i = lastIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_result' && block.tool_use_id != null) {
          answered.add(block.tool_use_id);
        }
      }
    }
  }

  for (const id of callIds) {
    if (!answered.has(id)) return true;
  }
  return false;
}

function detectGeminiUnfinished(contents: any[] | undefined): boolean {
  if (!Array.isArray(contents)) return false;

  let lastIdx = -1;
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i];
    if (content?.role === 'model' && Array.isArray(content.parts)) {
      const hasCall = content.parts.some((p: any) => p?.functionCall);
      if (hasCall) {
        lastIdx = i;
        break;
      }
    }
  }
  if (lastIdx === -1) return false;

  const callNames = new Set<string>();
  for (const part of contents[lastIdx].parts) {
    if (part?.functionCall?.name) callNames.add(part.functionCall.name);
  }
  if (callNames.size === 0) return false;

  const answered = new Set<string>();
  for (let i = lastIdx + 1; i < contents.length; i++) {
    const content = contents[i];
    if (Array.isArray(content?.parts)) {
      for (const part of content.parts) {
        if (part?.functionResponse?.name) answered.add(part.functionResponse.name);
      }
    }
  }

  for (const name of callNames) {
    if (!answered.has(name)) return true;
  }
  return false;
}

/**
 * Validate that the message/content sequence is legal for the target protocol
 * after cleaning (FR-10, FR-11). Returns true when the sequence is safe to send.
 *
 * - OpenAI: always valid (Chat Completions tolerates consecutive same-role).
 * - Anthropic / Gemini: user/assistant (or user/model) roles must alternate;
 *   two consecutive same-role entries are illegal.
 */
export function validateSequence(protocol: NormalizationProtocol, items: any[]): boolean {
  if (!Array.isArray(items) || items.length === 0) return true;
  if (protocol === 'openai') return true;

  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]?.role;
    const curr = items[i]?.role;
    if (prev && curr && prev === curr) return false;
  }
  return true;
}
