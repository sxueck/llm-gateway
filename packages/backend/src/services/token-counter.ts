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

// Inline binary/opaque payloads (Anthropic document + redacted_thinking, Responses
// input_file file_data) carry content the gateway cannot tokenize. Anthropic bills a
// PDF page at roughly 1.5K tokens, i.e. ~16 decoded bytes per token for a typical
// text page — far below the chars/4 text ratio on purpose, so an attachment estimate
// cannot manufacture a false block on its own. Upgrade path: sniff page counts.
const INLINE_BINARY_BYTES_PER_TOKEN = 16;

function estimateInlinePayloadTokens(base64Chars: number): number {
  if (!base64Chars) return 0;
  return Math.ceil((base64Chars * 3) / 4 / INLINE_BINARY_BYTES_PER_TOKEN);
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

/**
 * Cooperative variant of countTokensForText: identical fallback, but yields
 * periodically so encoding a long payload (serialized tool definitions on the
 * budget path) cannot stall the event loop.
 */
export async function countTextCooperatively(text: string): Promise<number> {
  if (!text) return 0;
  try {
    const enc = createYieldingEncoder(acquireEncoding());
    return await enc.countLong(text);
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
            } else if (item.type === 'image') {
              // Anthropic image block: keep the same weight as image_url.
              totalTokens += 85;
            } else if (item.type === 'thinking') {
              // Clients replay assistant thinking text on every later turn.
              totalTokens += encoding.encode(item.thinking || '').length;
            } else if (item.type === 'redacted_thinking') {
              totalTokens += estimateInlinePayloadTokens((item.data || '').length);
            } else if (item.type === 'document') {
              const data = typeof item.source?.data === 'string' ? item.source.data : '';
              totalTokens += data
                ? item.source.type === 'text'
                  ? encoding.encode(data).length
                  : estimateInlinePayloadTokens(data.length)
                : 0;
            } else if (item.type === 'tool_use') {
              totalTokens += encoding.encode(item.name || '').length;
              if (item.input !== undefined) {
                totalTokens += encoding.encode(JSON.stringify(item.input)).length;
              }
            } else if (item.type === 'tool_result') {
              totalTokens += 4;
              if (typeof item.content === 'string') {
                totalTokens += encoding.encode(item.content).length;
              } else if (Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part?.type === 'text' && part.text) {
                    totalTokens += encoding.encode(part.text).length;
                  } else if (part?.type === 'image') {
                    totalTokens += 85;
                  } else if (part?.type === 'document') {
                    const data = typeof part.source?.data === 'string' ? part.source.data : '';
                    totalTokens += data
                      ? part.source.type === 'text'
                        ? encoding.encode(data).length
                        : estimateInlinePayloadTokens(data.length)
                      : 0;
                  }
                }
              }
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
            } else if (item.type === 'image') {
              // Anthropic image block: flat heuristic, same budget weight as image_url.
              totalTokens += 85;
            } else if (item.type === 'thinking') {
              // Clients replay assistant thinking text on every later turn.
              totalTokens += await enc.countLong(item.thinking || '');
            } else if (item.type === 'redacted_thinking') {
              totalTokens += estimateInlinePayloadTokens((item.data || '').length);
            } else if (item.type === 'document') {
              const data = typeof item.source?.data === 'string' ? item.source.data : '';
              if (data) {
                totalTokens += item.source.type === 'text'
                  ? await enc.countLong(data)
                  : estimateInlinePayloadTokens(data.length);
              }
            } else if (item.type === 'tool_use') {
              // Anthropic assistant tool call: name + serialized input.
              totalTokens += enc.countShort(item.name || '');
              if (item.input !== undefined) {
                totalTokens += await enc.countLong(JSON.stringify(item.input));
              }
            } else if (item.type === 'tool_result') {
              // Anthropic user tool回包：content 为 string 或 blocks。
              totalTokens += 4;
              if (typeof item.content === 'string') {
                totalTokens += await enc.countLong(item.content);
              } else if (Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part?.type === 'text' && part.text) {
                    totalTokens += await enc.countLong(part.text);
                  } else if (part?.type === 'image') {
                    totalTokens += 85;
                  } else if (part?.type === 'document') {
                    const data = typeof part.source?.data === 'string' ? part.source.data : '';
                    if (data) {
                      totalTokens += part.source.type === 'text'
                        ? await enc.countLong(data)
                        : estimateInlinePayloadTokens(data.length);
                    }
                  }
                }
              }
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

/**
 * Cooperative token count for an OpenAI Responses API `input` payload
 * (string or item array). Counts every text the upstream re-reads each turn:
 * message input_text/output_text content, function_call name+arguments,
 * function_call_output payloads, reasoning summary/content text and item
 * reference ids. Images keep the flat 85-token heuristic used elsewhere.
 */
export async function countResponsesInputCooperatively(
  input: unknown
): Promise<number> {
  if (typeof input === 'string') {
    return input ? countTextCooperatively(input) : 0;
  }
  if (!Array.isArray(input) || input.length === 0) {
    return 0;
  }

  try {
    const enc = createYieldingEncoder(acquireEncoding());
    let totalTokens = 0;

    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const type = typeof item.type === 'string' ? item.type : '';

      if (type === 'function_call') {
        // Assistant tool call: name + serialized arguments (arguments is a
        // JSON string per spec, but tolerate objects).
        totalTokens += 4;
        totalTokens += enc.countShort(item.name || '');
        if (item.arguments !== undefined && item.arguments !== null) {
          totalTokens += await enc.countLong(
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments)
          );
        }
        await enc.maybeYield();
        continue;
      }

      if (type === 'function_call_output') {
        // Tool output: `output` is a string per spec; tolerate block arrays
        // ({ text } parts) and opaque objects via serialization.
        totalTokens += 4;
        if (typeof item.output === 'string') {
          totalTokens += await enc.countLong(item.output);
        } else if (Array.isArray(item.output)) {
          for (const part of item.output) {
            if (typeof part?.text === 'string' && part.text) {
              totalTokens += await enc.countLong(part.text);
            }
          }
        } else if (item.output !== undefined && item.output !== null) {
          totalTokens += await enc.countLong(JSON.stringify(item.output));
        }
        await enc.maybeYield();
        continue;
      }

      if (type === 'reasoning') {
        // Reasoning items: summary_text + reasoning_text both re-enter the
        // context on subsequent turns.
        totalTokens += 4;
        for (const field of ['summary', 'content'] as const) {
          const blocks = Array.isArray(item[field]) ? item[field] : [];
          for (const block of blocks) {
            if (typeof block?.text === 'string' && block.text) {
              totalTokens += await enc.countLong(block.text);
            }
          }
        }
        await enc.maybeYield();
        continue;
      }

      if (type === 'item_reference') {
        totalTokens += 4;
        if (typeof item.id === 'string') {
          totalTokens += enc.countShort(item.id);
        }
        continue;
      }

      if (type.endsWith('_call')) {
        // web_search_call / computer_call / mcp_call …: opaque action items,
        // counted as serialized JSON.
        totalTokens += 4;
        totalTokens += await enc.countLong(JSON.stringify(item));
        await enc.maybeYield();
        continue;
      }

      // Message items: typed 'message' plus type-less EasyInputMessage.
      totalTokens += 4;
      if (item.role) {
        totalTokens += enc.countShort(item.role);
      }

      const content = item.content;
      if (typeof content === 'string') {
        totalTokens += await enc.countLong(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string' && part.text) {
            // input_text / output_text / summary_text … all count.
            totalTokens += await enc.countLong(part.text);
          } else if (part?.type === 'input_image' || part?.type === 'image') {
            totalTokens += 85;
          } else if (part?.type === 'input_file') {
            if (typeof part.filename === 'string') {
              totalTokens += enc.countShort(part.filename);
            }
            // file_id / file_url resolve upstream; only inline file_data is visible here.
            if (typeof part.file_data === 'string') {
              totalTokens += estimateInlinePayloadTokens(part.file_data.length);
            }
          }
        }
      }

      if (item.name) {
        totalTokens += enc.countShort(item.name) - 1;
      }

      // Legacy chat-style inline calls inside a message item.
      if (item.function_call) {
        totalTokens += enc.countShort(item.function_call.name || '');
        totalTokens += enc.countShort(item.function_call.arguments || '');
      }
      if (item.tool_calls) {
        for (const toolCall of item.tool_calls) {
          if (toolCall.function) {
            totalTokens += enc.countShort(toolCall.function.name || '');
            totalTokens += enc.countShort(toolCall.function.arguments || '');
          }
        }
      }

      await enc.maybeYield();
    }

    return totalTokens;
  } catch {
    sharedEncoding = null;
    return Math.ceil(JSON.stringify(input).length / 4);
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
