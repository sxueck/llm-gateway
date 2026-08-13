export interface CleanStats {
  cleanedBlocks: number;
  cleanedChars: number;
}

export interface CleanResult<T> {
  payload: T;
  stats: CleanStats;
}

function approxChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

/**
 * Clean OpenAI Chat Completions messages (FR-7, FR-9). Strips `reasoning_content`
 * and `thinking_blocks` from assistant messages. Removes an assistant message
 * that becomes empty (no tool_calls and blank/absent content). Tool calls,
 * tool results, and user/system text are never touched (FR-8).
 */
export function cleanOpenAiMessages(messages: any[]): CleanResult<any[]> {
  const stats: CleanStats = { cleanedBlocks: 0, cleanedChars: 0 };

  const cleaned = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      cleaned.push(msg);
      continue;
    }

    if (msg.role === 'assistant') {
      let removed = false;
      if ('reasoning_content' in msg) {
        stats.cleanedBlocks += 1;
        stats.cleanedChars += approxChars(msg.reasoning_content);
        delete msg.reasoning_content;
        removed = true;
      }
      if ('thinking_blocks' in msg) {
        stats.cleanedBlocks += 1;
        stats.cleanedChars += approxChars(msg.thinking_blocks);
        delete msg.thinking_blocks;
        removed = true;
      }

      // FR-9: drop the message when it carries no tool_calls and no real content.
      if (removed && (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0)) {
        const content = msg.content;
        const isEmptyContent =
          content == null ||
          (typeof content === 'string' && content.trim() === '') ||
          (Array.isArray(content) && content.length === 0);
        if (isEmptyContent) {
          continue;
        }
      }
    }

    cleaned.push(msg);
  }

  return { payload: cleaned, stats };
}

/**
 * Clean OpenAI Responses API `input` (FR-7). Removes items whose `type` is
 * `reasoning`. `function_call` / `function_call_output` pairings and message
 * content are preserved (R-204).
 */
export function cleanResponsesInput(input: any[]): CleanResult<any[]> {
  const stats: CleanStats = { cleanedBlocks: 0, cleanedChars: 0 };

  const cleaned = [];
  for (const item of input) {
    if (item && typeof item === 'object' && item.type === 'reasoning') {
      stats.cleanedBlocks += 1;
      stats.cleanedChars += approxChars(item);
      continue;
    }
    cleaned.push(item);
  }

  return { payload: cleaned, stats };
}

/**
 * Clean Anthropic messages (FR-7, FR-10). Removes `thinking` and
 * `redacted_thinking` content blocks (with their signatures) from assistant
 * messages. Drops an assistant message whose content array becomes empty and
 * carries no `tool_use` block. Role-alternation legality is validated
 * separately (tool-loop.validateSequence).
 */
export function cleanAnthropicMessages(messages: any[]): CleanResult<any[]> {
  const stats: CleanStats = { cleanedBlocks: 0, cleanedChars: 0 };

  const cleaned = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      cleaned.push(msg);
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const keptBlocks = [];
      let hasToolUse = false;

      for (const block of msg.content) {
        if (block && typeof block === 'object' && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
          stats.cleanedBlocks += 1;
          stats.cleanedChars += approxChars(block.thinking) + approxChars(block.signature) + approxChars(block.data);
          continue;
        }
        if (block?.type === 'tool_use') hasToolUse = true;
        keptBlocks.push(block);
      }

      msg.content = keptBlocks;

      // FR-10: drop when content array empties and there is no tool_use block.
      if (keptBlocks.length === 0 && !hasToolUse) {
        continue;
      }
    }

    cleaned.push(msg);
  }

  return { payload: cleaned, stats };
}

/**
 * Clean Gemini `contents` (FR-7, FR-11). For model-role entries: drops parts
 * flagged `thought: true` and strips `thoughtSignature` from remaining parts
 * (signatures can attach to any part, including functionCall). Emptied model
 * content entries are removed. User/model alternation is validated separately.
 */
export function cleanGeminiContents(contents: any[]): CleanResult<any[]> {
  const stats: CleanStats = { cleanedBlocks: 0, cleanedChars: 0 };

  const cleaned = [];
  for (const content of contents) {
    if (!content || typeof content !== 'object') {
      cleaned.push(content);
      continue;
    }

    if (content.role === 'model' && Array.isArray(content.parts)) {
      const keptParts = [];
      for (const part of content.parts) {
        if (part && typeof part === 'object' && part.thought === true) {
          stats.cleanedBlocks += 1;
          stats.cleanedChars += approxChars(part.text);
          // A thought part may also carry a signature — count it.
          if ('thoughtSignature' in part) {
            stats.cleanedChars += approxChars(part.thoughtSignature);
          }
          continue;
        }
        if (part && typeof part === 'object' && 'thoughtSignature' in part) {
          stats.cleanedChars += approxChars(part.thoughtSignature);
          // Count stripped signatures as a block for audit parity.
          stats.cleanedBlocks += 1;
          delete part.thoughtSignature;
        }
        keptParts.push(part);
      }
      content.parts = keptParts;

      // FR-11: drop content entries whose parts emptied after cleaning.
      if (keptParts.length === 0) {
        continue;
      }
    }

    cleaned.push(content);
  }

  return { payload: cleaned, stats };
}
