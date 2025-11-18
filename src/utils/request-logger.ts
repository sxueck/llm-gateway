import { createInitialAggregate, processResponsesEvent } from './responses-parser.js';
const MAX_BODY_LENGTH = 2000; // 最大字节长度限制
const MAX_STRING_LENGTH = 500; // 单个字符串字段的最大字符长度（保守估计，确保总体不超过 2000 字节）

export interface ReasoningExtraction {
  reasoningContent: string;
  thinkingBlocks: any[];
  toolCalls?: any[];
}

/**
 * 递归截断对象中所有过长的字符串字段
 */
function truncateStringsRecursively(obj: any, maxLength: number = MAX_STRING_LENGTH): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // 如果是字符串，直接截断
  if (typeof obj === 'string') {
    return obj.length > maxLength
      ? obj.substring(0, maxLength) + '...[truncated]'
      : obj;
  }

  // 如果是数组，递归处理每个元素
  if (Array.isArray(obj)) {
    return obj.map(item => truncateStringsRecursively(item, maxLength));
  }

  // 如果是对象，递归处理每个属性
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        result[key] = truncateStringsRecursively(obj[key], maxLength);
      }
    }
    return result;
  }

  // 其他类型（number, boolean 等）直接返回
  return obj;
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
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;

    const truncated: any = {};

    for (const key in parsed) {
      if (key === 'tools') {
        // 工具定义通常很长，只显示数量
        truncated.tools = Array.isArray(parsed.tools)
          ? `[${parsed.tools.length} 个工具定义]`
          : parsed.tools;
      } else if (key === 'functions') {
        // 函数定义通常很长，只显示数量
        truncated.functions = Array.isArray(parsed.functions)
          ? `[${parsed.functions.length} 个函数定义]`
          : parsed.functions;
      } else {
        // 对所有其他字段进行递归截断
        truncated[key] = truncateStringsRecursively(parsed[key]);
      }
    }

    const result = JSON.stringify(truncated);
    // 如果最终结果还是太长，进行整体截断
    return result.length <= MAX_BODY_LENGTH
      ? result
      : result.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  } catch {
    // 如果解析失败，尝试作为字符串处理
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return bodyStr.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  }
}

export function truncateResponseBody(body: any): string {
  if (!body) return '';

  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;

    const truncated: any = {};

    for (const key in parsed) {
      if (key === 'choices' && Array.isArray(parsed.choices)) {
        // 特殊处理 choices，需要简化 tool_calls 和 function_call
        truncated.choices = parsed.choices.map((choice: any) => {
          const truncatedChoice = truncateStringsRecursively(choice);

          // 简化工具调用信息（通常很长且调试价值不高）
          if (truncatedChoice.message?.tool_calls) {
            truncatedChoice.message.tool_calls = '[工具调用已截断]';
          }
          if (truncatedChoice.message?.function_call) {
            truncatedChoice.message.function_call = '[函数调用已截断]';
          }

          return truncatedChoice;
        });
      } else {
        // 对其他所有字段进行递归截断
        truncated[key] = truncateStringsRecursively(parsed[key]);
      }
    }

    const result = JSON.stringify(truncated);
    // 如果最终结果还是太长，进行整体截断
    return result.length <= MAX_BODY_LENGTH
      ? result
      : result.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  } catch {
    // 如果解析失败，尝试作为字符串处理
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return bodyStr.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
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

/**
 * 累计 OpenAI Responses API 的流式事件，聚合 output_text 与 usage，用于日志/存档。
 */
export function accumulateResponsesStream(chunks: string[]): string {
  try {
    let agg = createInitialAggregate();

    for (const chunk of chunks) {
      if (!chunk.trim() || chunk.trim() === 'data: [DONE]') continue;

      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.substring(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const ev = JSON.parse(data);
          agg = processResponsesEvent(agg, ev);
        } catch {
          continue;
        }
      }
    }

    const accumulated: any = {
      type: 'responses.accumulated',
      id: agg.id,
      model: agg.model,
      status: agg.status,
      output_text: agg.outputText,
      usage: agg.usage,
    };

    return truncateResponseBody(accumulated);
  } catch {
    return chunks.join('').substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  }
}

