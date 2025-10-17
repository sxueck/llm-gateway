import { PromptConfig } from '../types/index.js';
import { memoryLogger } from './logger.js';

export interface PromptProcessorContext {
  date: string;
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export class PromptProcessor {
  processMessages(
    messages: ChatMessage[],
    promptConfig: PromptConfig,
    context: PromptProcessorContext
  ): ChatMessage[] {
    if (!promptConfig.enabled) {
      return messages;
    }

    const operationType = promptConfig.operationType;
    memoryLogger.debug(
      `处理 Prompt | 操作类型: ${operationType}`,
      'PromptProcessor'
    );

    switch (operationType) {
      case 'replace':
        return this.handleReplace(messages, promptConfig, context);
      case 'prepend':
        return this.handlePrepend(messages, promptConfig, context);
      case 'system':
        return this.handleSystem(messages, promptConfig, context);
      default:
        memoryLogger.warn(`未知的操作类型: ${operationType}`, 'PromptProcessor');
        return messages;
    }
  }

  private handleReplace(
    messages: ChatMessage[],
    promptConfig: PromptConfig,
    context: PromptProcessorContext
  ): ChatMessage[] {
    const lastUserMessage = this.getLastUserMessage(messages);
    if (!lastUserMessage) {
      return messages;
    }

    const userPromptText = this.extractTextContent(lastUserMessage.content);
    const newContent = this.replaceVariables(
      promptConfig.templateContent,
      userPromptText,
      context
    );

    memoryLogger.debug(
      `Replace 操作完成 | 原始长度: ${userPromptText.length} | 新长度: ${newContent.length}`,
      'PromptProcessor'
    );

    return this.updateLastUserMessage(messages, lastUserMessage, newContent);
  }

  private handlePrepend(
    messages: ChatMessage[],
    promptConfig: PromptConfig,
    context: PromptProcessorContext
  ): ChatMessage[] {
    const lastUserMessage = this.getLastUserMessage(messages);
    if (!lastUserMessage) {
      return messages;
    }

    const userPromptText = this.extractTextContent(lastUserMessage.content);
    const prependContent = this.replaceVariables(
      promptConfig.templateContent,
      userPromptText,
      context
    );

    const newContent = `${prependContent}\n\n${userPromptText}`;

    memoryLogger.debug(
      `Prepend 操作完成 | 添加长度: ${prependContent.length} | 总长度: ${newContent.length}`,
      'PromptProcessor'
    );

    return this.updateLastUserMessage(messages, lastUserMessage, newContent);
  }

  private handleSystem(
    messages: ChatMessage[],
    promptConfig: PromptConfig,
    context: PromptProcessorContext
  ): ChatMessage[] {
    if (!promptConfig.systemMessage) {
      memoryLogger.warn('System 操作缺少 systemMessage 配置', 'PromptProcessor');
      return messages;
    }

    const lastUserMessage = this.getLastUserMessage(messages);
    const userPromptText = lastUserMessage
      ? this.extractTextContent(lastUserMessage.content)
      : '';

    const systemContent = this.replaceVariables(
      promptConfig.systemMessage,
      userPromptText,
      context
    );

    const existingSystemIndex = messages.findIndex(m => m.role === 'system');

    if (existingSystemIndex >= 0) {
      memoryLogger.debug('替换现有 system message', 'PromptProcessor');
      return messages.map((m, idx) =>
        idx === existingSystemIndex ? { ...m, content: systemContent } : m
      );
    }

    memoryLogger.debug('添加新的 system message', 'PromptProcessor');
    return [{ role: 'system', content: systemContent }, ...messages];
  }

  private getLastUserMessage(messages: ChatMessage[]): ChatMessage | null {
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      memoryLogger.warn('没有找到用户消息，跳过操作', 'PromptProcessor');
      return null;
    }
    return userMessages.at(-1) || null;
  }

  private updateLastUserMessage(
    messages: ChatMessage[],
    lastUserMessage: ChatMessage,
    newContent: string
  ): ChatMessage[] {
    return messages.map(m => m === lastUserMessage ? { ...m, content: newContent } : m);
  }

  private extractTextContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join('\n');
    }

    return '';
  }

  private replaceVariables(
    template: string,
    userPrompt: string,
    context: PromptProcessorContext
  ): string {
    return template
      .split('{{user_prompt}}').join(userPrompt)
      .split('{{date}}').join(context.date);
  }

  parsePromptConfig(promptConfigJson: string | null): PromptConfig | null {
    if (!promptConfigJson) {
      return null;
    }

    try {
      const config = JSON.parse(promptConfigJson);
      
      if (!config.operationType || !config.templateContent) {
        memoryLogger.warn('Prompt 配置缺少必要字段', 'PromptProcessor');
        return null;
      }

      if (!['replace', 'prepend', 'system'].includes(config.operationType)) {
        memoryLogger.warn(`无效的操作类型: ${config.operationType}`, 'PromptProcessor');
        return null;
      }

      return {
        operationType: config.operationType,
        templateContent: config.templateContent,
        systemMessage: config.systemMessage,
        enabled: config.enabled !== false,
      };
    } catch (error: any) {
      memoryLogger.error(`解析 Prompt 配置失败: ${error.message}`, 'PromptProcessor');
      return null;
    }
  }
}

export const promptProcessor = new PromptProcessor();

