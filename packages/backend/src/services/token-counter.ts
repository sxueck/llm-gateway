import { get_encoding } from 'tiktoken';

type EncodingInstance = ReturnType<typeof get_encoding>;

let sharedEncoding: EncodingInstance | null = null;

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
  } catch (error: any) {
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
  } catch (error: any) {
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
  } catch (error: any) {
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

export async function countRequestTokens(
  requestBody: any,
  responseBody?: any
): Promise<TokenCountResult> {
  if (!requestBody || typeof requestBody !== 'object') {
    return Promise.resolve({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });
  }

  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        let promptTokens = 0;
        let completionTokens = 0;

        if (requestBody.messages && Array.isArray(requestBody.messages)) {
          promptTokens = countTokensForMessages(requestBody.messages);
        } else if (Array.isArray(requestBody.contents)) {
          const text = requestBody.contents
            .flatMap((content: any) => Array.isArray(content?.parts) ? content.parts : [])
            .map((part: any) => typeof part?.text === 'string' ? part.text : '')
            .filter(Boolean)
            .join('\n');
          promptTokens = countTokensForText(text);
        } else if (requestBody.input) {
          const inputText = Array.isArray(requestBody.input)
            ? requestBody.input.join(' ')
            : requestBody.input;
          promptTokens = countTokensForText(inputText);
        } else if (requestBody.prompt) {
          promptTokens = countTokensForText(requestBody.prompt);
        }

        if (responseBody) {
          if (responseBody.choices && Array.isArray(responseBody.choices)) {
            for (const choice of responseBody.choices) {
              if (choice.message?.content) {
                completionTokens += countTokensForText(choice.message.content);
              } else if (choice.text) {
                completionTokens += countTokensForText(choice.text);
              }
            }
          } else if (responseBody.data && Array.isArray(responseBody.data)) {
            completionTokens = 0;
          }
        }

        const totalTokens = promptTokens + completionTokens;

        resolve({
          promptTokens,
          completionTokens,
          totalTokens
        });
      } catch (error: any) {
        resolve({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        });
      }
    });
  });
}

export async function countStreamResponseTokens(
  requestBody: any,
  streamChunks: string[]
): Promise<TokenCountResult> {
  if (!requestBody || typeof requestBody !== 'object') {
    return Promise.resolve({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });
  }

  if (!streamChunks || !Array.isArray(streamChunks)) {
    return Promise.resolve({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });
  }

  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        let promptTokens = 0;
        let completionTokens = 0;

        if (requestBody.messages && Array.isArray(requestBody.messages)) {
          promptTokens = countTokensForMessages(requestBody.messages);
        }

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
        }

        const fullContent = contentParts.join('');
        if (fullContent) {
          completionTokens = countTokensForText(fullContent);
        }

        const totalTokens = promptTokens + completionTokens;

        resolve({
          promptTokens,
          completionTokens,
          totalTokens
        });
      } catch (error: any) {
        resolve({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        });
      }
    });
  });
}

process.once('exit', () => {
  if (sharedEncoding) {
    sharedEncoding.free();
    sharedEncoding = null;
  }
});
