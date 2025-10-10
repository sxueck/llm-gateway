const MAX_BODY_LENGTH = 10000;

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
      
      if (parsed.model) truncated.model = parsed.model;
      if (parsed.stream !== undefined) truncated.stream = parsed.stream;
      if (parsed.temperature !== undefined) truncated.temperature = parsed.temperature;
      if (parsed.max_tokens !== undefined) truncated.max_tokens = parsed.max_tokens;
      
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
      
      if (parsed.tools) {
        truncated.tools = `[${parsed.tools.length} 个工具定义]`;
      }
      
      if (parsed.functions) {
        truncated.functions = `[${parsed.functions.length} 个函数定义]`;
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
          
          if (parsed.choices && parsed.choices[0]?.delta?.content) {
            messages.push(parsed.choices[0].delta.content);
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
    
    if (lastUsage) {
      accumulated.usage = lastUsage;
    }
    
    return truncateResponseBody(accumulated);
  } catch {
    return chunks.join('').substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  }
}

