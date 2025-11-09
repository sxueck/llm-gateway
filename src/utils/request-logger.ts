const MAX_BODY_LENGTH = 10000;

export interface ReasoningExtraction {
  reasoningContent: string;
  thinkingBlocks: any[];
  toolCalls?: any[];
}

export function buildFullRequestBody(
  requestBody: any,
  modelAttributes?: any
): any {
  const fullRequest: any = { ...requestBody };

  if (modelAttributes?.supports_reasoning) {
    fullRequest.extra_body = {
      ...fullRequest.extra_body,
      enable_thinking: true,
    };
  }

  if (modelAttributes?.supports_interleaved_thinking) {
    fullRequest.extra_body = {
      ...fullRequest.extra_body,
      reasoning_split: true,
    };
  }

  return fullRequest;
}

export function extractReasoningFromChoice(
  choice: any,
  existingReasoning: string = '',
  existingBlocks: any[] = [],
  existingToolCalls: any[] = []
): ReasoningExtraction {
  let reasoningContent = existingReasoning;
  const thinkingBlocks = [...existingBlocks];
  const toolCalls = [...existingToolCalls];

  if (choice.delta?.reasoning_content) {
    reasoningContent += choice.delta.reasoning_content;
  }

  if (choice.message?.reasoning_content && !existingReasoning) {
    reasoningContent = choice.message.reasoning_content;
  }

  if (choice.delta?.thinking_blocks && Array.isArray(choice.delta.thinking_blocks)) {
    thinkingBlocks.push(...choice.delta.thinking_blocks);
  }

  if (choice.message?.thinking_blocks && Array.isArray(choice.message.thinking_blocks)) {
    const existingIds = new Set(thinkingBlocks.map(b => JSON.stringify(b)));
    for (const block of choice.message.thinking_blocks) {
      const blockId = JSON.stringify(block);
      if (!existingIds.has(blockId)) {
        thinkingBlocks.push(block);
        existingIds.add(blockId);
      }
    }
  }

  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls)) {
    for (const deltaToolCall of choice.delta.tool_calls) {
      const index = deltaToolCall.index;
      if (index !== undefined) {
        if (!toolCalls[index]) {
          toolCalls[index] = {
            id: deltaToolCall.id || '',
            type: deltaToolCall.type || 'function',
            function: {
              name: deltaToolCall.function?.name || '',
              arguments: deltaToolCall.function?.arguments || ''
            }
          };
        } else {
          if (deltaToolCall.id) toolCalls[index].id = deltaToolCall.id;
          if (deltaToolCall.function?.name) toolCalls[index].function.name = deltaToolCall.function.name;
          if (deltaToolCall.function?.arguments) {
            toolCalls[index].function.arguments += deltaToolCall.function.arguments;
          }
        }
      }
    }
  }

  if (choice.message?.tool_calls && Array.isArray(choice.message.tool_calls)) {
    toolCalls.push(...choice.message.tool_calls);
  }

  return {
    reasoningContent,
    thinkingBlocks,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
  };
}

export function truncateRequestBody(body: any): string {
  if (!body) return '';

  try {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    if (bodyStr.length <= MAX_BODY_LENGTH) {
      return bodyStr;
    }

    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;

      const truncated: any = {};

      for (const key in parsed) {
        if (key === 'messages') {
          continue;
        } else if (key === 'tools') {
          truncated.tools = `[${parsed.tools.length} 个工具定义]`;
        } else if (key === 'functions') {
          truncated.functions = `[${parsed.functions.length} 个函数定义]`;
        } else {
          truncated[key] = parsed[key];
        }
      }

      if (parsed.messages && Array.isArray(parsed.messages)) {
        truncated.messages = parsed.messages.map((msg: any) => {
          const truncatedMsg: any = { role: msg.role };

          if (typeof msg.content === 'string') {
            truncatedMsg.content = msg.content.length > 1000
              ? msg.content.substring(0, 1000) + '...[truncated]'
              : msg.content;
          } else if (Array.isArray(msg.content)) {
            truncatedMsg.content = msg.content.map((item: any) => {
              if (item.type === 'text' && item.text) {
                return {
                  type: 'text',
                  text: item.text.length > 1000
                    ? item.text.substring(0, 1000) + '...[truncated]'
                    : item.text
                };
              }
              return item;
            });
          } else {
            truncatedMsg.content = msg.content;
          }

          if (msg.name) truncatedMsg.name = msg.name;
          if (msg.tool_calls) truncatedMsg.tool_calls = '[工具调用已截断]';
          if (msg.tool_call_id) truncatedMsg.tool_call_id = msg.tool_call_id;

          return truncatedMsg;
        });
      }

      const result = JSON.stringify(truncated);
      return result.length <= MAX_BODY_LENGTH
        ? result
        : result.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
    } catch {
      return bodyStr.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
    }
  } catch {
    return '';
  }
}

export function truncateResponseBody(body: any): string {
  if (!body) return '';

  try {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    
    if (bodyStr.length <= MAX_BODY_LENGTH) {
      return bodyStr;
    }

    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      
      const truncated: any = {};
      
      if (parsed.id) truncated.id = parsed.id;
      if (parsed.object) truncated.object = parsed.object;
      if (parsed.created) truncated.created = parsed.created;
      if (parsed.model) truncated.model = parsed.model;
      
      if (parsed.choices && Array.isArray(parsed.choices)) {
        truncated.choices = parsed.choices.map((choice: any) => {
          const truncatedChoice: any = { index: choice.index };
          
          if (choice.message) {
            const msg = choice.message;
            truncatedChoice.message = { role: msg.role };

            if (typeof msg.content === 'string') {
              truncatedChoice.message.content = msg.content.length > 1000
                ? msg.content.substring(0, 1000) + '...[truncated]'
                : msg.content;
            } else {
              truncatedChoice.message.content = msg.content;
            }

            if (msg.reasoning_content) {
              truncatedChoice.message.reasoning_content = msg.reasoning_content.length > 1000
                ? msg.reasoning_content.substring(0, 1000) + '...[truncated]'
                : msg.reasoning_content;
            }

            if (msg.thinking_blocks && Array.isArray(msg.thinking_blocks)) {
              truncatedChoice.message.thinking_blocks = msg.thinking_blocks.map((block: any) => ({
                type: block.type,
                thinking: block.thinking?.length > 500
                  ? block.thinking.substring(0, 500) + '...[truncated]'
                  : block.thinking,
                signature: block.signature ? '[signature]' : undefined
              }));
            }

            if (msg.tool_calls) {
              truncatedChoice.message.tool_calls = '[工具调用已截断]';
            }
            if (msg.function_call) {
              truncatedChoice.message.function_call = '[函数调用已截断]';
            }
          }
          
          if (choice.delta) {
            truncatedChoice.delta = choice.delta;
          }
          
          if (choice.finish_reason) {
            truncatedChoice.finish_reason = choice.finish_reason;
          }
          
          return truncatedChoice;
        });
      }
      
      if (parsed.usage) {
        truncated.usage = parsed.usage;
      }
      
      if (parsed.error) {
        truncated.error = parsed.error;
      }
      
      const result = JSON.stringify(truncated);
      return result.length <= MAX_BODY_LENGTH
        ? result
        : result.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
    } catch {
      return bodyStr.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
    }
  } catch {
    return '';
  }
}

export function accumulateStreamResponse(chunks: string[]): string {
  try {
    const messages: any[] = [];
    let reasoningContent = '';
    let thinkingBlocks: any[] = [];
    let toolCalls: any[] = [];
    let lastUsage: any = null;
    let model = '';
    let id = '';

    for (const chunk of chunks) {
      if (!chunk.trim() || chunk.trim() === 'data: [DONE]') continue;

      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.substring(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.id && !id) id = parsed.id;
          if (parsed.model && !model) model = parsed.model;

          if (parsed.choices && parsed.choices[0]) {
            const choice = parsed.choices[0];

            if (choice.delta?.content) {
              messages.push(choice.delta.content);
            }

            const extraction = extractReasoningFromChoice(choice, reasoningContent, thinkingBlocks, toolCalls);
            reasoningContent = extraction.reasoningContent;
            thinkingBlocks = extraction.thinkingBlocks;
            toolCalls = extraction.toolCalls || [];
          }

          if (parsed.usage) {
            lastUsage = parsed.usage;
          }
        } catch {
          continue;
        }
      }
    }

    const accumulated: any = {
      id,
      model,
      choices: [{
        message: {
          role: 'assistant',
          content: messages.join('')
        }
      }]
    };

    if (reasoningContent) {
      accumulated.choices[0].message.reasoning_content = reasoningContent;
    }

    if (thinkingBlocks.length > 0) {
      accumulated.choices[0].message.thinking_blocks = thinkingBlocks;
    }

    if (toolCalls.length > 0) {
      accumulated.choices[0].message.tool_calls = toolCalls;
    }

    if (lastUsage) {
      accumulated.usage = lastUsage;
    }

    return truncateResponseBody(accumulated);
  } catch {
    return chunks.join('').substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  }
}

