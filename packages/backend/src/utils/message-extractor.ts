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
  
  // 从 messages 中提取 system（OpenAI 格式）
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg && !systemPrompt) {
    if (!options?.strip_system_prompt) {
      systemPrompt = extractTextFromContent(systemMsg.content, options);
    }
    processedMessages = messages.filter(m => m.role !== 'system');
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
