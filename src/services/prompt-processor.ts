import { PromptConfig } from '../types/index.js';
import { memoryLogger } from './logger.js';

export interface PromptProcessorContext {
  date: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

    const newContent = this.replaceVariables(
      promptConfig.templateContent,
      lastUserMessage.content,
      context
    );

    memoryLogger.debug(
      `Replace 操作完成 | 原始长度: ${lastUserMessage.content.length} | 新长度: ${newContent.length}`,
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

    const prependContent = this.replaceVariables(
      promptConfig.templateContent,
      lastUserMessage.content,
      context
    );

    const newContent = `${prependContent}\n\n${lastUserMessage.content}`;

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
    const userContent = lastUserMessage?.content || '';

    const systemContent = this.replaceVariables(
      promptConfig.systemMessage,
      userContent,
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
    return userMessages[userMessages.length - 1];
  }

  private updateLastUserMessage(
    messages: ChatMessage[],
    lastUserMessage: ChatMessage,
    newContent: string
  ): ChatMessage[] {
    return messages.map(m => m === lastUserMessage ? { ...m, content: newContent } : m);
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

