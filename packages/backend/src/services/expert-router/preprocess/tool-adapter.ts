
import { ProxyRequest, ToolSignal } from '../types.js';

export class ToolAdapter {
  static extractToolSignals(request: ProxyRequest): ToolSignal[] {
    const signals: ToolSignal[] = [];
    const body = request.body || {};
    
    // Handle Chat Completions (OpenAI/Anthropic if normalized)
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || typeof msg !== 'object') continue;

        // OpenAI Tool Calls (Assistant)
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const call of msg.tool_calls) {
            signals.push({
              type: 'call',
              name: call.function?.name,
              content: JSON.stringify(call.function?.arguments),
              isError: false
            });
          }
        }
        
        // OpenAI Tool Results (Tool)
        if (msg.role === 'tool') {
             const isError = ToolAdapter.detectError(msg.content);
             signals.push({
               type: 'result',
               content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
               isError
             });
        }

        // Anthropic Tool Use (Assistant)
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part?.type === 'tool_use') {
                    signals.push({
                        type: 'call',
                        name: part.name,
                        content: JSON.stringify(part.input),
                        isError: false
                    });
                }
            }
        }

        // Anthropic Tool Result (User)
        // Anthropic uses 'user' role for tool results in API
        if (msg.role === 'user' && Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part?.type === 'tool_result') {
                    // Check explicit is_error field or fallback to content analysis
                    const isError = part.is_error === true || ToolAdapter.detectError(part.content);
                    signals.push({
                        type: 'result',
                        name: part.tool_use_id,
                        content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
                        isError
                    });
                }
            }
        }
      }
    }

    // Handle Responses API (input array)
    if (Array.isArray(body.input)) {
        for (const item of body.input) {
            if (!item || typeof item !== 'object') continue;

            if (item.type === 'message' && item.role === 'tool') {
                // OpenAI Responses API tool result
                 let content = '';
                 if (Array.isArray(item.content)) {
                   content = item.content.map((c: any) => c.text || '').join('');
                 } else {
                   content = String(item.content || '');
                 }

                 const isError = ToolAdapter.detectError(content);
                 signals.push({
                   type: 'result',
                   content,
                   isError
                 });
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
