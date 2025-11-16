/**
 * 内容截断工具
 * 用于截断API请求和响应中的长文本内容
 */

const MAX_TEXT_LENGTH = 400; // 文本内容最大长度

/**
 * 截断消息内容
 * 支持字符串和Anthropic协议的数组类型内容
 */
function truncateMessageContent(content: any): any {
  if (!content) return content;

  if (typeof content === 'string') {
    // 字符串类型：直接截断
    if (content.length > MAX_TEXT_LENGTH) {
      return content.substring(0, MAX_TEXT_LENGTH) + '...[truncated]';
    }
    return content;
  }

  if (Array.isArray(content)) {
    // Anthropic协议：数组类型，截断text块
    return content.map((block: any) => {
      if (block.type === 'text' && block.text && block.text.length > MAX_TEXT_LENGTH) {
        return {
          ...block,
          text: block.text.substring(0, MAX_TEXT_LENGTH) + '...[truncated]'
        };
      }
      return block;
    });
  }

  return content;
}

/**
 * 截断请求或响应体中的内容
 * 用于数据库存储前的数据处理
 */
export function truncateBodyContent(bodyStr: string | null | undefined): string | null {
  if (!bodyStr) return null;

  try {
    const parsed = JSON.parse(bodyStr);

    // 处理请求体中的messages
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg: any) => ({
        ...msg,
        content: truncateMessageContent(msg.content)
      }));
    }

    // 处理响应体中的choices
    if (parsed.choices && Array.isArray(parsed.choices)) {
      parsed.choices = parsed.choices.map((choice: any) => {
        if (choice.message?.content) {
          return {
            ...choice,
            message: {
              ...choice.message,
              content: truncateMessageContent(choice.message.content)
            }
          };
        }
        return choice;
      });
    }

    return JSON.stringify(parsed);
  } catch (error) {
    // JSON解析失败，直接截断
    if (bodyStr.length > MAX_TEXT_LENGTH * 2) {
      return bodyStr.substring(0, MAX_TEXT_LENGTH * 2) + '...[truncated]';
    }
    return bodyStr;
  }
}

/**
 * 提取消息内容的文本预览
 * 用于前端列表展示
 */
export function extractContentPreview(content: any, maxLength: number = MAX_TEXT_LENGTH): string {
  if (!content) return '';

  if (typeof content === 'string') {
    return content.substring(0, maxLength) + (content.length > maxLength ? '...' : '');
  }

  if (Array.isArray(content)) {
    // Anthropic协议：提取text类型的内容
    const textContent = content.find((item: any) => item.type === 'text')?.text || '';
    return textContent.substring(0, maxLength) + (textContent.length > maxLength ? '...' : '');
  }

  return JSON.stringify(content).substring(0, maxLength) + '...';
}