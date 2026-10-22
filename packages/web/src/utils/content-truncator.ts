
const MAX_TEXT_LENGTH = 400;

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

export function extractRequestPreview(requestBody: string | null): string {
  if (!requestBody) return '-';
  
  try {
    const parsed = JSON.parse(requestBody);
    const messageContent = parsed.messages?.[0]?.content;
    if (messageContent) {
      const preview = extractContentPreview(messageContent);
      if (preview) return preview;
    }

    return '-';
  } catch {
    return requestBody.substring(0, 50) + '...';
  }
}
