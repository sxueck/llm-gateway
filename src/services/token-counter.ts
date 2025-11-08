import { get_encoding } from 'tiktoken';

function countTokensForText(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  let encoding;
  try {
    encoding = get_encoding('cl100k_base');
    const tokens = encoding.encode(text);
    return tokens.length;
  } catch (error: any) {
    return Math.ceil(text.length / 4);
  } finally {
    if (encoding) {
      encoding.free();
    }
  }
}

export function countTokensForMessages(messages: any[]): number {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  let encoding;
  try {
    encoding = get_encoding('cl100k_base');

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
    const totalText = messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join('');
    return Math.ceil(totalText.length / 4);
  } finally {
    if (encoding) {
      encoding.free();
    }
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

