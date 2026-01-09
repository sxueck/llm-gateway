/**
 * 内容截断工具 - 前端版本
 * 用于在列表中显示API请求和响应的预览
 */

const MAX_TEXT_LENGTH = 400; // 文本内容最大长度

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

/**
 * 从请求体中提取预览内容
 */
export function extractRequestPreview(requestBody: string | null): string {
  if (!requestBody) return '-';
  
  try {
    const parsed = JSON.parse(requestBody);
    const messageContent = parsed.messages?.[0]?.content;
    
    if (messageContent) {
      return extractContentPreview(messageContent);
    }
    
    if (parsed.model) {
      return parsed.model;
    }
    
    return '...';
  } catch {
    return requestBody.substring(0, 50) + '...';
  }
}

/**
 * 从响应体中提取预览内容
 */
export function extractResponsePreview(responseBody: string | null): string {
  if (!responseBody) return '-';
  
  try {
    const parsed = JSON.parse(responseBody);
    const messageContent = parsed.choices?.[0]?.message?.content;
    
    if (messageContent) {
      return extractContentPreview(messageContent);
    }
    
    if (parsed.error?.message) {
      return parsed.error.message.substring(0, MAX_TEXT_LENGTH) + 
             (parsed.error.message.length > MAX_TEXT_LENGTH ? '...' : '');
    }
    
    return '...';
  } catch {
    return responseBody.substring(0, 50) + '...';
  }
}