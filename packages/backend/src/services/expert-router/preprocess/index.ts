
import { ProxyRequest, RoutingSignal, HardHint } from '../types.js';
import { ToolAdapter } from './tool-adapter.js';
import { extractUserMessagesForClassification } from '../../../utils/message-extractor.js';
import { countRequestTokens, countTokensForText } from '../../token-counter.js';

export interface PreprocessOptions {
  strip_tools?: boolean;
  strip_files?: boolean;
  strip_code_blocks?: boolean;
  strip_system_prompt?: boolean;
}

export class SignalBuilder {
  static async buildRoutingSignal(request: ProxyRequest, options?: PreprocessOptions): Promise<RoutingSignal> {
    const { lastUserMessage, conversationHistory } = await SignalBuilder.extractText(request, options);
    
    // 1. Hard Hints (Slash commands)
    const hardHints: HardHint[] = SignalBuilder.extractHardHints(lastUserMessage);
    
    // 2. Tool Signals
    // Always extract tool signals as *signals*.
    // `strip_tools` only affects what we feed into the classifier text, not whether we can
    // use tool activity as a routing fallback when user text is empty.
    const toolSignals: any[] = ToolAdapter.extractToolSignals(request);
    
    // 3. Denoise Intent Text
    const originalIntentText = lastUserMessage;
    let intentText = SignalBuilder.denoiseText(lastUserMessage, options);

    // Tools can be critical for intent (agentic workflows). Treat `strip_tools` as:
    // - true: keep classifier text clean, but attach compact tool summary
    // - false: attach richer tool structure/context
    const toolContext = SignalBuilder.buildToolContext(
      request,
      toolSignals,
      options?.strip_tools ? 'compact' : 'full'
    );
    if (toolContext) {
      intentText = intentText && intentText.trim().length > 0
        ? `${intentText}\n\n${toolContext}`
        : toolContext;
    }

    // If user text becomes empty after denoise and no tool context exists, keep a compact tool intent.
    if ((!intentText || intentText.trim().length === 0) && Array.isArray(toolSignals) && toolSignals.length > 0) {
      intentText = SignalBuilder.summarizeToolCalls(request, toolSignals);
    }

    // Calculate stats
    const tokenCounterResult = await countRequestTokens(request.body || {});
    const promptTokens = tokenCounterResult.promptTokens;

    const originalTokens = countTokensForText(originalIntentText);
    const cleanedTokens = countTokensForText(intentText);
    const removedTokens = Math.max(0, originalTokens - cleanedTokens);
    const removedTokensPct = originalTokens > 0
      ? removedTokens / originalTokens
      : 0;

    const stats = {
      originalLength: originalIntentText.length,
      cleanedLength: intentText.length,
      promptTokens,
      originalTokens,
      cleanedTokens,
      removedTokens,
      removedTokensPct,
      tokenizer: 'tiktoken/cl100k_base'
    };

    return {
      intentText,
      historyHint: conversationHistory,
      toolSignals,
      hardHints,
      originalRequest: request,
      stats
    };
  }

  // ... (extractText stays same)

  private static async extractText(
    request: ProxyRequest,
    options?: PreprocessOptions
  ): Promise<{ lastUserMessage: string; conversationHistory: string }> {
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

          // Respect preprocessing options for Responses API message roles.
          if (options?.strip_tools && item.role === 'tool') continue;
          if (options?.strip_system_prompt && item.role === 'system') continue;

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

    return extractUserMessagesForClassification(messages, system, options);
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

  private static denoiseText(text: string, options?: PreprocessOptions): string {
    if (!text) return '';
    let processed = text;

    const hadEnvDetails = /<environment_details>/i.test(processed);

    // Some exports wrap the full payload as a JSON-ish `"content": "..."` field.
    // Unwrap it before further denoise so downstream regexes work on the real text.
    const contentWrapper = processed.match(/^\s*"?content"?\s*:\s*([\s\S]+)$/i);
    if (contentWrapper && contentWrapper[1]) {
      processed = contentWrapper[1].trim();
      // Strip a single pair of surrounding quotes if present.
      if (processed.length >= 2 && processed.startsWith('"') && processed.endsWith('"')) {
        processed = processed.slice(1, -1);
        // Minimal unescape for common log/export formats.
        processed = processed
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"');
      }
    }

    // Some clients (e.g. IDE agents) wrap the real user question and environment noise in XML-ish tags.
    // For routing, keep the user question and drop environment details.
    const userMsgMatch = processed.match(/<user_message[^>]*>\s*([\s\S]*?)\s*<\/user_message>/i);
    if (userMsgMatch && userMsgMatch[1] && userMsgMatch[1].trim().length > 0) {
      processed = userMsgMatch[1].trim();
    } else {
      processed = processed.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '');

      // Defensive: if closing tag is missing, avoid wiping out the whole prompt.
      const lower = processed.toLowerCase();
      const openIdx = lower.indexOf('<environment_details>');
      const closeIdx = lower.indexOf('</environment_details>');
      if (openIdx !== -1 && closeIdx === -1) {
        // If env_details appears at the start, keep the suffix (it may contain the real question).
        if (processed.slice(0, openIdx).trim().length === 0) {
          processed = processed.replace(/<environment_details>/i, '');
        } else {
          // Otherwise, keep the prefix (likely the question) and drop the tail.
          processed = processed.slice(0, openIdx);
        }
      }
    }

    // Strip common transcript scaffolding (keeps only the human intent text).
    processed = processed
      .replace(/^Latest User Prompt:\s*/gmi, '')
      .replace(/^\[\d+\]\s*(User|Assistant):\s*/gmi, '')
      .replace(/^\s*[-=]{3,}\s*$/gm, '')
      .trim();

    // If denoise removed everything and the prompt was mainly env noise, keep it empty.
    // Otherwise, fall back to the original input to avoid over-aggressive stripping.
    if (!processed || processed.trim().length === 0) {
      if (hadEnvDetails) return '';
      processed = text;
    }
    
    // Match code blocks ```lang ... ```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    
    processed = processed.replace(codeBlockRegex, (match, lang, code) => {
        const lines = code.split('\n');
        
        // If strip_code_blocks is enabled, strip ALL code blocks
        if (options?.strip_code_blocks) {
             return `\`\`\`${lang}\n[CODE_BLOCK_REMOVED]\n\`\`\``;
        }

        // Default behavior: Keep short code blocks (< 10 lines)
        if (lines.length < 10) return match;
        
        return `\`\`\`${lang}\n[CODE_BLOCK_OMITTED_FOR_ROUTING: ${lines.length} lines]\n\`\`\``;
    });

    return processed.replace(/\n{3,}/g, '\n\n').trim();
  }

  private static summarizeToolCalls(request: ProxyRequest, toolSignals: any[]): string {
    const body: any = request.body || {};
    const tools = Array.isArray(body.tools) ? body.tools : [];

    const descByName = new Map<string, string>();
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;

      // OpenAI: { type: 'function', function: { name, description } }
      if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
        const name = tool.function.name;
        const desc = tool.function.description;
        if (typeof name === 'string' && name) {
          descByName.set(name, typeof desc === 'string' ? desc : '');
        }
        continue;
      }

      // Anthropic-style: { name, description }
      if (typeof tool.name === 'string' && tool.name) {
        descByName.set(tool.name, typeof tool.description === 'string' ? tool.description : '');
      }
    }

    const counts = new Map<string, number>();
    for (const s of toolSignals) {
      if (!s || typeof s !== 'object') continue;
      if (s.type !== 'call') continue;
      if (typeof s.name !== 'string' || !s.name) continue;
      counts.set(s.name, (counts.get(s.name) || 0) + 1);
    }

    const names = [...counts.keys()];
    if (names.length === 0) {
      return '请求包含工具交互';
    }

    const parts = names.slice(0, 8).map((name) => {
      const times = counts.get(name) || 1;
      const rawDesc = descByName.get(name) || '';
      const shortDesc = rawDesc.replace(/\s+/g, ' ').trim();
      const desc = shortDesc.length > 96 ? `${shortDesc.slice(0, 93)}...` : shortDesc;
      const timesHint = times > 1 ? ` x${times}` : '';
      return desc
        ? `请求调用了${name}${timesHint}（${desc}）`
        : `请求调用了${name}${timesHint}`;
    });

    const suffix = names.length > 8 ? `；另有 ${names.length - 8} 个工具未展开` : '';
    return parts.join('；') + suffix;
  }

  private static buildToolContext(
    request: ProxyRequest,
    toolSignals: any[],
    mode: 'compact' | 'full'
  ): string {
    const body: any = request.body || {};
    const tools = Array.isArray(body.tools) ? body.tools : [];

    const hasSignals = Array.isArray(toolSignals) && toolSignals.length > 0;
    const hasTools = tools.length > 0;
    if (!hasSignals && !hasTools) return '';

    if (mode === 'compact') {
      return hasSignals ? SignalBuilder.summarizeToolCalls(request, toolSignals) : '';
    }

    const lines: string[] = [];

    if (hasTools) {
      lines.push('工具定义:');
      for (const tool of tools.slice(0, 12)) {
        if (!tool || typeof tool !== 'object') continue;

        // OpenAI: { type: 'function', function: { name, description, parameters } }
        if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
          const name = typeof tool.function.name === 'string' ? tool.function.name : 'unknown';
          const desc = typeof tool.function.description === 'string' ? tool.function.description : '';
          const params = tool.function.parameters;
          const paramsKeys = params && typeof params === 'object'
            ? Object.keys((params as any).properties || {}).slice(0, 12)
            : [];
          const keysHint = paramsKeys.length > 0 ? ` | params: ${paramsKeys.join(', ')}` : '';
          lines.push(`- ${name}${desc ? `: ${desc}` : ''}${keysHint}`);
          continue;
        }

        // Anthropic-style / simplified: { name, description, input_schema }
        if (typeof (tool as any).name === 'string') {
          const name = (tool as any).name;
          const desc = typeof (tool as any).description === 'string' ? (tool as any).description : '';
          const schema = (tool as any).input_schema;
          const schemaKeys = schema && typeof schema === 'object'
            ? Object.keys((schema as any).properties || {}).slice(0, 12)
            : [];
          const keysHint = schemaKeys.length > 0 ? ` | params: ${schemaKeys.join(', ')}` : '';
          lines.push(`- ${name}${desc ? `: ${desc}` : ''}${keysHint}`);
        }
      }
      if (tools.length > 12) lines.push(`- ... (另有 ${tools.length - 12} 个工具)`);
    }

    if (hasSignals) {
      const calls = toolSignals.filter(s => s && typeof s === 'object' && s.type === 'call').slice(0, 8);
      const results = toolSignals.filter(s => s && typeof s === 'object' && s.type === 'result').slice(0, 6);

      if (calls.length > 0) {
        lines.push('工具调用:');
        for (const c of calls) {
          const name = typeof c.name === 'string' && c.name ? c.name : 'unknown';
          const content = typeof c.content === 'string' ? c.content : '';
          const short = content.replace(/\s+/g, ' ').trim();
          const clipped = short.length > 240 ? `${short.slice(0, 237)}...` : short;
          lines.push(`- ${name}${clipped ? ` args=${clipped}` : ''}`);
        }
      }

      if (results.length > 0) {
        lines.push('工具结果:');
        for (const r of results) {
          const content = typeof r.content === 'string' ? r.content : '';
          const short = content.replace(/\s+/g, ' ').trim();
          const clipped = short.length > 240 ? `${short.slice(0, 237)}...` : short;
          const hint = r.isError ? 'error' : 'ok';
          lines.push(`- (${hint}) ${clipped}`);
        }
      }
    }

    const joined = lines.join('\n').trim();
    // Keep it bounded to avoid overwhelming the classifier.
    return joined.length > 8000 ? `${joined.slice(0, 7997)}...` : joined;
  }
}
