
import { ProxyRequest, RoutingSignal, HardHint } from '../types.js';
import { ToolAdapter } from './tool-adapter.js';
import { extractResponsesInputForClassification, extractUserMessagesForClassification } from '../../../utils/message-extractor.js';
import { extractUserIntentFromMixedText } from '../../../utils/mixed-intent-extractor.js';
import { countRequestTokens, countTokensForText, truncateToTokenLimit } from '../../token-counter.js';

export interface PreprocessOptions {
  strip_tools?: boolean;
  strip_files?: boolean;
  strip_code_blocks?: boolean;
  strip_system_prompt?: boolean;
}

/** Hard cap on intent text length fed to classifiers (matches local ONNX max_tokens default). */
// Classify-side preprocessing stays on the main thread by design: the intent
// text is hard-capped here before tokenize/ONNX, bounding tokenizer JS cost to
// a few ms (ONNX inference itself is native-async). Revisit worker offload of
// the whole classifyWithLocalOnnx only if profiling shows this budget blown.
const INTENT_TEXT_TOKEN_LIMIT = 1024;

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

    // Progressive compression preserves the user's actual intent (typically at
    // the end) instead of a blunt head truncation.
    let intentTruncated = false;
    if (countTokensForText(intentText) > INTENT_TEXT_TOKEN_LIMIT) {
      const compressed = SignalBuilder.compressIntentToTokenLimit(intentText, INTENT_TEXT_TOKEN_LIMIT);
      intentText = compressed.text;
      intentTruncated = true;
    }

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
      intentTruncated,
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

  private static async extractText(
    request: ProxyRequest,
    options?: PreprocessOptions
  ): Promise<{ lastUserMessage: string; conversationHistory: string }> {
    const body: any = request.body || {};

    // Gemini native API uses contents[].parts[].text instead of messages.
    if (Array.isArray(body.contents)) {
      const messages = body.contents.map((content: any) => ({
        role: content?.role === 'model' ? 'assistant' : 'user',
        content: Array.isArray(content?.parts)
          ? content.parts.map((part: any) => ({ text: part?.text, content: part?.text }))
          : content?.parts,
      }));
      return extractUserMessagesForClassification(messages, body.systemInstruction, options);
    }

    // Responses API
    if (body.input !== undefined || typeof body.text === 'string') {
      const input = body.input ?? body.text;
      if (typeof input === 'string') {
        return { lastUserMessage: input, conversationHistory: '' };
      }

      if (Array.isArray(input)) {
        const extracted = extractResponsesInputForClassification(input, options);
        return {
          lastUserMessage: extracted.lastUserMessage,
          conversationHistory: extracted.conversationHistory
        };
      }

      return { lastUserMessage: JSON.stringify(input), conversationHistory: '' };
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
    let processed = extractUserIntentFromMixedText(text);

    // Some system components generate a long, rigid template (Task/Guidelines/Output/Chat History).
    // For routing, keep the *task intent* and compact chat history, and drop the rest.
    const extracted = SignalBuilder.extractTaskTemplate(processed);
    if (extracted) processed = extracted;

    const hadEnvDetails = /<environment_details>/i.test(processed);

    // Some clients (e.g. IDE agents) wrap the real user question and environment noise in XML-ish tags.
    // For routing, keep the user question and drop environment details.
    const userMsgMatch = processed.match(/<user_message[^>]*>\s*([\s\S]*?)\s*<\/user_message>/i);
    if (userMsgMatch && userMsgMatch[1] && userMsgMatch[1].trim().length > 0) {
      processed = userMsgMatch[1].trim();
    } else {
      processed = processed.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '');
      processed = processed.replace(/<file_content[^>]*>[\s\S]*?<\/file_content>/gi, '');

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

  private static extractTaskTemplate(text: string): string | null {
    const t = (text || '').toString();
    if (!t.includes('### Task') && !t.includes('<chat_history>')) return null;

    // Extract task body between "### Task:" and next "###" header (if present).
    const taskMatch = t.match(/###\s*Task\s*:\s*\n([\s\S]*?)(?=\n###\s*[A-Za-z]|\n<chat_history>|$)/i);
    const task = taskMatch?.[1]?.trim();

    // Extract chat history in tags (if present), and keep it bounded.
    const historyMatch = t.match(/<chat_history>\s*([\s\S]*?)\s*<\/chat_history>/i);
    const historyRaw = historyMatch?.[1]?.trim();
    const history = historyRaw
      ? historyRaw.replace(/\s+$/g, '').slice(0, 800)
      : '';

    if (!task && !history) return null;

    const parts: string[] = [];
    if (task) parts.push(`Task: ${task}`);
    if (history) parts.push(`ChatHistory: ${history}`);
    return parts.join('\n\n').trim();
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

  /**
   * 渐进式压缩意图文本到 token 限制内。
   *
   * 策略：优先牺牲低信号内容，保留用户真实意图（通常在末尾）。
   *  Level 1 — 更激进地压缩代码块（>3 行的替换为摘要占位符）
   *  Level 2 — 移除工具定义/调用/结果段落（低信号上下文）
   *  Level 3 — 头尾保留截断（尾部占 65%，因为最新意图在末尾）
   */
  private static compressIntentToTokenLimit(text: string, maxTokens: number): { text: string } {
    let level1 = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code: string) => {
      const lines = code.split('\n');
      if (lines.length > 3) {
        return `\`\`\`${lang}\n[CODE_BLOCK_SUMMARY: ${lines.length} lines]\n\`\`\``;
      }
      return match;
    });
    if (countTokensForText(level1) <= maxTokens) {
      return { text: level1 };
    }

    const paragraphs = level1.split(/\n\n+/);
    const filtered = paragraphs.filter(p => {
      const trimmed = p.trim();
      return !trimmed.startsWith('工具定义:') &&
             !trimmed.startsWith('工具调用:') &&
             !trimmed.startsWith('工具结果:');
    });
    const level2 = filtered.join('\n\n').trim();
    if (countTokensForText(level2) <= maxTokens) {
      return { text: level2 + '\n[...工具上下文已省略]' };
    }

    const result = truncateToTokenLimit(level2, maxTokens, 'headAndTail');
    return { text: result.text };
  }
}
