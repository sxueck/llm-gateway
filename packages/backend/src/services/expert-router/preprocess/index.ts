
import { ProxyRequest, RoutingSignal, HardHint } from '../types.js';
import { ToolAdapter } from './tool-adapter.js';
import { extractUserMessagesForClassification } from '../../../utils/message-extractor.js';

export class SignalBuilder {
  static async buildRoutingSignal(request: ProxyRequest): Promise<RoutingSignal> {
    const { lastUserMessage, conversationHistory } = await SignalBuilder.extractText(request);
    
    // 1. Hard Hints (Slash commands)
    const hardHints: HardHint[] = SignalBuilder.extractHardHints(lastUserMessage);
    
    // 2. Tool Signals
    const toolSignals = ToolAdapter.extractToolSignals(request);
    
    // 3. Denoise Intent Text
    const intentText = SignalBuilder.denoiseText(lastUserMessage);

    return {
      intentText,
      historyHint: conversationHistory,
      toolSignals,
      hardHints,
      originalRequest: request
    };
  }

  private static async extractText(request: ProxyRequest): Promise<{ lastUserMessage: string; conversationHistory: string }> {
    const body: any = request.body || {};

    // Responses API
    if (body.input !== undefined || typeof body.text === 'string') {
      const input = body.input ?? body.text;
      let lastUserMessage = '';

      if (typeof input === 'string') {
        lastUserMessage = input;
      } else if (Array.isArray(input)) {
        const texts: string[] = [];
        for (const item of input) {
          if (!item || typeof item !== 'object') continue;

          // { type: 'message', role: 'user', content: [ { type: 'input_text', text: '...' } ] }
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part && typeof part === 'object') {
                if (part.type === 'input_text' && typeof part.text === 'string') {
                  texts.push(part.text);
                } else if (typeof part.text === 'string') {
                  texts.push(part.text);
                } else if (typeof part.content === 'string') {
                  texts.push(part.content);
                }
              }
            }
          } else if (typeof item.text === 'string') {
            texts.push(item.text);
          }
        }
        lastUserMessage = texts.join('\n').trim();
        if (!lastUserMessage) {
          lastUserMessage = JSON.stringify(input);
        }
      } else {
        lastUserMessage = JSON.stringify(input);
      }

      // Responses API typically doesn't send full history in 'input' the same way 'messages' does
      // unless provided in conversation context, which we might not have full access to here easily.
      // So we assume history is empty or implicit.
      return { lastUserMessage, conversationHistory: '' };
    }

    // Chat Completions API
    const messages = body.messages || [];
    const system = body.system;

    return extractUserMessagesForClassification(messages, system);
  }

  private static extractHardHints(text: string): HardHint[] {
    const hints: HardHint[] = [];
    if (!text) return hints;
    
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
        const parts = trimmed.split(/\s+/);
        const command = parts[0]; 
        
        // Heuristic: valid slash command has length > 1 and usually < 20 chars
        if (command.length > 1 && command.length < 20) {
            hints.push({
                type: 'slash_command',
                value: command,
                args: parts.slice(1)
            });
        }
    }
    return hints;
  }

  private static denoiseText(text: string): string {
    if (!text) return '';
    let processed = text;
    
    // Match code blocks ```lang ... ```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    
    processed = processed.replace(codeBlockRegex, (match, lang, code) => {
        const lines = code.split('\n');
        // Keep short code blocks (< 10 lines) as they might be critical for context
        if (lines.length < 10) return match;
        
        return `\`\`\`${lang}\n[CODE_BLOCK_OMITTED_FOR_ROUTING: ${lines.length} lines]\n\`\`\``;
    });

    return processed;
  }
}
