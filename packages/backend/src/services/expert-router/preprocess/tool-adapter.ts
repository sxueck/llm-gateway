
import { ProxyRequest, ToolSignal } from '../types.js';

export class ToolAdapter {
  static extractToolSignals(request: ProxyRequest): ToolSignal[] {
    const signals: ToolSignal[] = [];
    const body = request.body || {};

     const pushCall = (name: any, payload: any) => {
       const toolName = typeof name === 'string' ? name : undefined;
       signals.push({
         type: 'call',
         name: toolName,
         content: payload === undefined ? undefined : JSON.stringify(payload),
         isError: false,
       });
     };

     const pushResult = (name: any, payload: any) => {
       const toolName = typeof name === 'string' ? name : undefined;
       const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
       const isError = ToolAdapter.detectError(content);
       signals.push({
         type: 'result',
         name: toolName,
         content,
         isError,
       });
     };
    
    // Handle Chat Completions (OpenAI/Anthropic if normalized)
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || typeof msg !== 'object') continue;

        // OpenAI Tool Calls (Assistant)
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const call of msg.tool_calls) {
            pushCall(call.function?.name, call.function?.arguments);
          }
        }
        
        // OpenAI Tool Results (Tool)
        if (msg.role === 'tool') {
             pushResult(undefined, msg.content);
        }

        // Anthropic Tool Use (Assistant)
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part?.type === 'tool_use') {
                    pushCall(part.name, part.input);
                }
            }
        }

        // Anthropic Tool Result (User)
        // Anthropic uses 'user' role for tool results in API
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part?.type === 'tool_result') {
                    // Check explicit is_error field or fallback to content analysis
                    const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                    const isError = part.is_error === true || ToolAdapter.detectError(content);
                    signals.push({ type: 'result', name: part.tool_use_id, content, isError });
                }
            }
        }
      }
    }

    // Handle Responses API (input array)
    if (Array.isArray(body.input)) {
        for (const item of body.input) {
            if (!item || typeof item !== 'object') continue;

             // Some clients may include tool calls/results as standalone input items.
             if (item.type === 'tool_call' || item.type === 'function_call') {
               pushCall(item.name || item.function?.name, item.arguments ?? item.input ?? item);
               continue;
             }
             if (item.type === 'tool_result' || item.type === 'tool_output') {
               pushResult(item.name || item.tool_name || item.tool_call_id, item.content ?? item.output ?? item);
               continue;
             }

             // Or embed them as content blocks under a message.
             if (item.type === 'message' && Array.isArray(item.content)) {
               for (const part of item.content) {
                 if (!part || typeof part !== 'object') continue;
                 if (part.type === 'tool_call' || part.type === 'function_call') {
                   pushCall(part.name || part.function?.name, part.arguments ?? part.input ?? part);
                 } else if (part.type === 'tool_result' || part.type === 'tool_output') {
                   pushResult(part.name || part.tool_name || part.tool_call_id, part.content ?? part.output ?? part);
                 }
               }
             }

             if (item.type === 'message' && item.role === 'tool') {
                 // OpenAI Responses API tool result
                  let content = '';
                  if (Array.isArray(item.content)) {
                    content = item.content.map((c: any) => c.text || '').join('');
                  } else {
                    content = String(item.content || '');
                  }

                 const isError = ToolAdapter.detectError(content);
                 signals.push({ type: 'result', content, isError });
             }
        }
    }

    return signals;
  }

  private static detectError(content: any): boolean {
    if (!content) return false;
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    
    // Simple heuristic for common error patterns
    // 1. Python Traceback
    if (str.includes('Traceback (most recent call last)')) return true;
    
    // 2. Common error prefixes (case insensitive)
    const lower = str.toLowerCase();
    if (lower.startsWith('error:') || lower.includes('exception:')) return true;
    
    return false;
  }
}
