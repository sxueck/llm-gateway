/**
 * 消息提取工具 - 用于专家路由分类
 * 支持 OpenAI 和 Anthropic 协议
 */

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: any;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[] | any;
}

interface ResponsesMessageItem {
  type?: string;
  role?: string;
  content?: any;
  text?: string;
  [key: string]: any;
}

export interface MessageExtractOptions {
  strip_tools?: boolean;
  strip_files?: boolean;
  strip_system_prompt?: boolean;
}

/**
 * 从 Anthropic ContentBlock 或字符串中提取纯文本
 */
export function extractTextFromContent(
  content: string | ContentBlock[] | any,
  options?: MessageExtractOptions
): string {
  if (content === null || content === undefined) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }
  
  if (!Array.isArray(content)) {
    return options?.strip_files ? '' : JSON.stringify(content);
  }
  
  // ContentBlock[] → 提取 type='text' 的文本
  return content
    .filter(block => block && block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n');
}

/**
 * 提取用户消息用于分类
 * 自动处理 OpenAI 和 Anthropic 格式
 */
export function extractUserMessagesForClassification(
  messages: ChatMessage[],
  system?: any,
  options?: MessageExtractOptions
): {
  lastUserMessage: string;
  conversationHistory: string;
  systemPrompt?: string;
} {
  let systemPrompt: string | undefined;
  let processedMessages = messages;
  
  // 处理独立的 system 参数（Anthropic 格式）
  if (system && !options?.strip_system_prompt) {
    systemPrompt = extractTextFromContent(system, options);
  }
  
  // 从 messages 中提取 system/developer（OpenAI 格式）
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  if (systemMsgs.length > 0) {
    if (!options?.strip_system_prompt && !systemPrompt) {
      systemPrompt = systemMsgs
        .map(m => extractTextFromContent(m.content, options))
        .filter(Boolean)
        .join('\n');
    }
    processedMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  }

  if (options?.strip_tools) {
    processedMessages = processedMessages.filter(m => m.role !== 'tool');
  }
  
  // 提取用户消息
  const userMessages = processedMessages.filter(m => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found for classification');
  }
  
  const lastUserMsg = userMessages[userMessages.length - 1];
  const lastUserMessage = extractTextFromContent(lastUserMsg.content, options);
  
  // 构建对话历史
  const conversationHistory = buildConversationHistory(processedMessages, lastUserMsg, options);
  
  return { lastUserMessage, conversationHistory, systemPrompt };
}

function extractTextFromResponsesItemContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof (part as any).text === 'string') {
      texts.push((part as any).text);
    } else if (typeof (part as any).content === 'string') {
      texts.push((part as any).content);
    }
  }
  return texts.join('\n').trim();
}

export function extractResponsesInputForClassification(
  input: ResponsesMessageItem[],
  options?: MessageExtractOptions
): {
  lastUserMessage: string;
  conversationHistory: string;
  systemPrompt?: string;
} {
  const items = Array.isArray(input) ? input : [];
  if (items.length === 0) {
    // Keep the classifier path resilient: return something rather than throwing.
    return { lastUserMessage: '[]', conversationHistory: '' };
  }

  // Normalize items to ChatMessage-like shape with plain-text content.
  const normalized: ChatMessage[] = [];
  const fallbackTexts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const role = typeof item.role === 'string' ? item.role : undefined;
    if (role) {
      if (options?.strip_tools && role === 'tool') continue;
      if (options?.strip_system_prompt && (role === 'system' || role === 'developer')) continue;

      let contentText = '';
      if (typeof (item as any).text === 'string') {
        contentText = (item as any).text;
      } else {
        contentText = extractTextFromResponsesItemContent((item as any).content);
      }

      normalized.push({ role, content: contentText });
      continue;
    }

    // Responses API can include role-less input items such as:
    // - { type: 'input_text', text: '...' }
    // - { text: '...' }
    // Treat these as user-provided text rather than failing the entire request.
    const directText = typeof (item as any).text === 'string' ? ((item as any).text as string) : '';
    const contentText = extractTextFromResponsesItemContent((item as any).content);
    const bestEffort = (directText || contentText || '').trim();
    if (bestEffort) fallbackTexts.push(bestEffort);
  }

  if (normalized.length === 0) {
    const fallback = fallbackTexts.join('\n').trim();
    return {
      lastUserMessage: fallback || JSON.stringify(items),
      conversationHistory: ''
    };
  }

  // Extract system prompt (if present in the input array).
  let systemPrompt: string | undefined;
  if (!options?.strip_system_prompt) {
    const systemParts = normalized
      .filter(m => m.role === 'system' || m.role === 'developer')
      .map(m => extractTextFromContent(m.content, options))
      .filter(Boolean);
    if (systemParts.length > 0) systemPrompt = systemParts.join('\n');
  }

  // Remove system/developer from the conversation used for history and user-intent extraction.
  const processed = normalized.filter(m => m.role !== 'system' && m.role !== 'developer');

  const userMessages = processed.filter(m => m.role === 'user');
  if (userMessages.length === 0) {
    // Some Responses inputs may not contain explicit user-role messages (e.g. only role-less items).
    // Fall back to the best-effort extracted text rather than throwing.
    const fallback = fallbackTexts.join('\n').trim();
    const lastAny = processed.length > 0 ? processed[processed.length - 1] : normalized[normalized.length - 1];
    const lastAnyText = lastAny ? extractTextFromContent(lastAny.content, options) : '';
    return {
      lastUserMessage: fallback || lastAnyText || JSON.stringify(items),
      conversationHistory: '',
      systemPrompt
    };
  }

  const lastUserMsg = userMessages[userMessages.length - 1];
  const lastUserMessage = extractTextFromContent(lastUserMsg.content, options);
  const conversationHistory = buildConversationHistory(processed, lastUserMsg, options);

  return { lastUserMessage, conversationHistory, systemPrompt };
}

/**
 * 构建对话历史上下文
 */
function buildConversationHistory(
  messages: ChatMessage[],
  lastUserMessage: ChatMessage,
  options?: MessageExtractOptions
): string {
  const lastUserIndex = messages.lastIndexOf(lastUserMessage);
  
  // 如果最后一条用户消息是第一条消息，则没有历史
  if (lastUserIndex <= 0) {
    return '';
  }
  
  // 提取历史消息（最多 3 轮对话，即 6 条消息）
  const MAX_CONTEXT_MESSAGES = 3;
  const startIndex = Math.max(0, lastUserIndex - MAX_CONTEXT_MESSAGES * 2);
  const contextMessages = messages.slice(startIndex, lastUserIndex);
  
  if (contextMessages.length === 0) {
    return '';
  }
  
  // 格式化历史消息
  const formattedMessages = contextMessages.map((msg, index) => {
    const content = extractTextFromContent(msg.content, options);
    const roleLabel = getRoleLabel(msg.role);
    const messageNumber = index + 1;

    return `[${messageNumber}] ${roleLabel}: ${content}`;
  });
  
  return formattedMessages.join('\n');
}

/**
 * 获取角色标签
 */
function getRoleLabel(role: string): string {
  const roleMap: Record<string, string> = {
    'user': 'User',
    'assistant': 'Assistant',
    'system': 'System'
  };
  
  return roleMap[role.toLowerCase()] || role;
}
