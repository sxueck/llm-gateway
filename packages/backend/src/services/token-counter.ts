import { get_encoding } from 'tiktoken';

type EncodingInstance = ReturnType<typeof get_encoding>;

let sharedEncoding: EncodingInstance | null = null;

// Encode segmentation cadence: bounds the worst-case event-loop stall to a few
// ms per segment so post-stream accounting never freezes concurrent streams.
// Segment boundaries split BPE merges, shifting estimates by a handful of
// tokens on very long inputs (<0.1%); upstream usage always wins over these
// fallback estimates whenever present.
const ENCODE_SEGMENT_CHARS = 16_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Shared char-budget encoder: long strings are encoded in bounded segments,
 * small fields accumulate toward the same budget so huge histories still
 * yield between messages. Per-segment fallback mirrors countTokensForText:
 * a broken encoder resets the cache and estimates by characters.
 */
function createYieldingEncoder(encoding: EncodingInstance) {
  let unyieldedChars = 0;

  const maybeYield = async (): Promise<void> => {
    if (unyieldedChars >= ENCODE_SEGMENT_CHARS) {
      await yieldToEventLoop();
      unyieldedChars = 0;
    }
  };

  const encodeOrEstimate = (text: string): number => {
    try {
      return encoding.encode(text).length;
    } catch {
      sharedEncoding = null;
      return Math.ceil(text.length / 4);
    }
  };

  const countLong = async (text: string): Promise<number> => {
    let total = 0;
    for (let offset = 0; offset < text.length; offset += ENCODE_SEGMENT_CHARS) {
      const slice = text.slice(offset, Math.min(offset + ENCODE_SEGMENT_CHARS, text.length));
      total += encodeOrEstimate(slice);
      unyieldedChars += slice.length;
      await maybeYield();
    }
    return total;
  };

  const countShort = (text: string): number => {
    const n = encodeOrEstimate(text);
    unyieldedChars += text.length;
    return n;
  };

  return { countLong, countShort, maybeYield };
}

function acquireEncoding(): EncodingInstance {
  if (!sharedEncoding) {
    sharedEncoding = get_encoding('cl100k_base');
  }
  return sharedEncoding;
}

export function countTokensForText(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  try {
    const encoding = acquireEncoding();
    const tokens = encoding.encode(text);
    return tokens.length;
  } catch {
    sharedEncoding = null;
    return Math.ceil(text.length / 4);
  }
}

export type TruncationStrategy = 'head' | 'headAndTail';

/**
 * Truncate text to at most `maxTokens` tokens.
 *
 * - `'head'`: preserve content from the start (simple head truncation).
 * - `'headAndTail'`: keep both the opening context (~35%) and the closing
 *   intent (~65%), dropping the middle. Useful when the real user intent
 *   sits at the end of a long prompt.
 *
 * Falls back to character-based truncation on encoder errors.
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number,
  strategy: TruncationStrategy = 'head',
): { text: string; truncated: boolean; originalTokens: number } {
  if (!text || typeof text !== 'string' || maxTokens <= 0) {
    return { text: text || '', truncated: false, originalTokens: 0 };
  }

  try {
    const encoding = acquireEncoding();
    const tokens = encoding.encode(text);

    if (tokens.length <= maxTokens) {
      return { text, truncated: false, originalTokens: tokens.length };
    }

    const decodeSlice = (slice: Uint32Array): string => {
      const bytes = encoding.decode(slice);
      let s = new TextDecoder().decode(bytes);
      // Strip trailing replacement chars from broken multi-byte boundaries.
      while (s.endsWith('\uFFFD')) s = s.slice(0, -1);
      return s;
    };

    let truncatedText: string;

    if (strategy === 'headAndTail') {
      const separator = '\n[...中段内容省略...]\n';
      const separatorTokens = encoding.encode(separator).length;
      const budget = Math.max(maxTokens - separatorTokens, Math.floor(maxTokens * 0.5));
      const headTokens = Math.floor(budget * 0.35);
      const tailTokens = budget - headTokens;
      const head = decodeSlice(tokens.slice(0, headTokens)).trimEnd();
      const tail = decodeSlice(tokens.slice(-tailTokens)).trimStart();
      truncatedText = head + separator + tail;
    } else {
      truncatedText = decodeSlice(tokens.slice(0, maxTokens)).trimEnd() + '\n[...truncated]';
    }

    return {
      text: truncatedText,
      truncated: true,
      originalTokens: tokens.length,
    };
  } catch {
    sharedEncoding = null;
    const charLimit = maxTokens * 4;
    if (text.length <= charLimit) {
      return { text, truncated: false, originalTokens: Math.ceil(text.length / 4) };
    }

    if (strategy === 'headAndTail') {
      const separator = '\n[...中段内容省略...]\n';
      const budget = charLimit - separator.length;
      const headChars = Math.floor(budget * 0.35);
      const tailChars = budget - headChars;
      return {
        text: text.slice(0, headChars) + separator + text.slice(-tailChars),
        truncated: true,
        originalTokens: Math.ceil(text.length / 4),
      };
    }

    return {
      text: text.slice(0, charLimit).trimEnd() + '\n[...truncated]',
      truncated: true,
      originalTokens: Math.ceil(text.length / 4),
    };
  }
}

export function countTokensForMessages(messages: any[]): number {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  try {
    const encoding = acquireEncoding();

    let totalTokens = 0;

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      totalTokens += 4;

      if (message.role) {
        totalTokens += encoding.encode(message.role).length;
      }

      if (message.content) {
        if (typeof message.content === 'string') {
          totalTokens += encoding.encode(message.content).length;
        } else if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (item.type === 'text' && item.text) {
              totalTokens += encoding.encode(item.text).length;
            } else if (item.type === 'image_url') {
              totalTokens += 85;
            }
          }
        }
      }

      if (message.name) {
        totalTokens += encoding.encode(message.name).length - 1;
      }

      if (message.function_call) {
        totalTokens += encoding.encode(message.function_call.name || '').length;
        totalTokens += encoding.encode(message.function_call.arguments || '').length;
      }

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.function) {
            totalTokens += encoding.encode(toolCall.function.name || '').length;
            totalTokens += encoding.encode(toolCall.function.arguments || '').length;
          }
        }
      }
    }

    totalTokens += 2;

    return totalTokens;
  } catch {
    sharedEncoding = null;
    const totalText = messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join('');
    return Math.ceil(totalText.length / 4);
  }
}

export interface TokenCountResult {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Mirrors countTokensForMessages exactly (same +4/+2 frame overhead), but
 * yields periodically so encoding a large history cannot stall the loop.
 * Identical results for inputs below one segment.
 */
/**
 * Public cooperative variant of countTokensForMessages: identical counting
 * semantics, but yields periodically so encoding a long history cannot stall
 * the event loop. Used by the request-path compression accounting.
 */
export async function countMessagesCooperatively(
  messages: any[]
): Promise<number> {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  try {
    const enc = createYieldingEncoder(acquireEncoding());
    let totalTokens = 0;

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      totalTokens += 4;

      if (message.role) {
        totalTokens += enc.countShort(message.role);
      }

      if (message.content) {
        if (typeof message.content === 'string') {
          totalTokens += await enc.countLong(message.content);
        } else if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (item.type === 'text' && item.text) {
              totalTokens += await enc.countLong(item.text);
            } else if (item.type === 'image_url') {
              totalTokens += 85;
            }
          }
        }
      }

      if (message.name) {
        totalTokens += enc.countShort(message.name) - 1;
      }

      if (message.function_call) {
        totalTokens += enc.countShort(message.function_call.name || '');
        totalTokens += enc.countShort(message.function_call.arguments || '');
      }

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.function) {
            totalTokens += enc.countShort(toolCall.function.name || '');
            totalTokens += enc.countShort(toolCall.function.arguments || '');
          }
        }
      }

      await enc.maybeYield();
    }

    totalTokens += 2;

    return totalTokens;
  } catch {
    sharedEncoding = null;
    const totalText = messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join('');
    return Math.ceil(totalText.length / 4);
  }
}

export async function countRequestTokens(
  requestBody: any,
  responseBody?: any
): Promise<TokenCountResult> {
  if (!requestBody || typeof requestBody !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  try {
    const encoding = acquireEncoding();
    let promptTokens = 0;
    let completionTokens = 0;

    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      promptTokens = await countMessagesCooperatively(requestBody.messages);
    } else if (Array.isArray(requestBody.contents)) {
      // Gemini format: join all text parts, encode cooperatively.
      const enc = createYieldingEncoder(encoding);
      let joined = '';
      for (const content of requestBody.contents) {
        const parts = Array.isArray(content?.parts) ? content.parts : [];
        for (const part of parts) {
          if (typeof part?.text === 'string' && part.text) {
            if (joined.length > 0) joined += '\n';
            joined += part.text;
            await enc.maybeYield();
          }
        }
      }
      promptTokens = joined ? await enc.countLong(joined) : 0;
    } else if (requestBody.input !== undefined && requestBody.input !== null && requestBody.input !== '') {
      // Array inputs are joined (matching previous behavior); non-string
      // scalars are not tokenizable and yield 0 like the old text-guard did.
      const inputText = Array.isArray(requestBody.input)
        ? requestBody.input.join(' ')
        : (typeof requestBody.input === 'string' ? requestBody.input : '');
      const enc = createYieldingEncoder(encoding);
      promptTokens = inputText ? await enc.countLong(inputText) : 0;
    } else if (typeof requestBody.prompt === 'string' && requestBody.prompt) {
      const enc = createYieldingEncoder(encoding);
      promptTokens = requestBody.prompt ? await enc.countLong(requestBody.prompt) : 0;
    }

    if (responseBody?.choices && Array.isArray(responseBody.choices)) {
      const enc = createYieldingEncoder(encoding);
      for (const choice of responseBody.choices) {
        const content = choice.message?.content ?? choice.text;
        if (typeof content === 'string' && content) {
          completionTokens += await enc.countLong(content);
        }
      }
    }
    // Embeddings responses carry no completion tokens.

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  } catch {
    sharedEncoding = null;
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

export async function countStreamResponseTokens(
  requestBody: any,
  streamChunks: string[]
): Promise<TokenCountResult> {
  if (!requestBody || typeof requestBody !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  if (!streamChunks || !Array.isArray(streamChunks)) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  try {
    const encoding = acquireEncoding();
    let promptTokens = 0;
    let completionTokens = 0;

    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      promptTokens = await countMessagesCooperatively(requestBody.messages);
    }

    const enc = createYieldingEncoder(encoding);
    const contentParts: string[] = [];
    for (const chunk of streamChunks) {
      if (!chunk.trim() || chunk.trim() === 'data: [DONE]') continue;

      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.substring(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.choices && parsed.choices[0]?.delta?.content) {
            contentParts.push(parsed.choices[0].delta.content);
          }
          // OpenAI Responses API SSE 解析：response.output_text.delta
          else if (parsed.type && typeof parsed.type === 'string' && parsed.type.includes('output_text.delta')) {
            const txt = (parsed.delta && typeof parsed.delta.text === 'string')
              ? parsed.delta.text
              : (typeof parsed.text === 'string' ? parsed.text : '');
            if (txt) {
              contentParts.push(txt);
            }
          }
        } catch {
          continue;
        }
      }

      await enc.maybeYield();
    }

    const fullContent = contentParts.join('');
    if (fullContent) {
      completionTokens = await enc.countLong(fullContent);
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  } catch {
    sharedEncoding = null;
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}

process.once('exit', () => {
  if (sharedEncoding) {
    sharedEncoding.free();
    sharedEncoding = null;
  }
});
