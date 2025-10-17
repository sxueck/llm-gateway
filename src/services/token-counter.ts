import { Tiktoken, encoding_for_model } from 'tiktoken';
import { ChatMessage } from './prompt-processor.js';
import { memoryLogger } from './logger.js';

export class TokenCounter {
  private encoder: Tiktoken | null = null;
  private modelName: string;

  constructor(modelName: string = 'gpt-4') {
    this.modelName = modelName;
    this.initEncoder();
  }

  private initEncoder(): void {
    try {
      this.encoder = encoding_for_model(this.modelName as any);
    } catch (error: any) {
      try {
        this.encoder = encoding_for_model('gpt-4');
        memoryLogger.warn(
          `模型 ${this.modelName} 不支持 (${error.message}), 使用 gpt-4 编码器`,
          'TokenCounter'
        );
      } catch (fallbackError: any) {
        memoryLogger.error(
          `初始化 Token 计数器失败: ${fallbackError.message}`,
          'TokenCounter'
        );
      }
    }
  }

  countTokens(text: string): number {
    if (!this.encoder) {
      return Math.ceil(text.length / 4);
    }

    try {
      return this.encoder!.encode(text).length;
    } catch (error: any) {
      memoryLogger.error(
        `Token 计数失败: ${error.message}`,
        'TokenCounter'
      );
      return Math.ceil(text.length / 4);
    }
  }

  countMessagesTokens(messages: ChatMessage[]): number {
    if (!this.encoder) {
      return messages.reduce((total, msg) => {
        const content = typeof msg.content === 'string' ? msg.content : '';
        return total + Math.ceil(content.length / 4);
      }, 0);
    }

    let totalTokens = 0;

    for (const message of messages) {
      totalTokens += 4;
      totalTokens += this.countTokens(message.role);

      if (typeof message.content === 'string') {
        totalTokens += this.countTokens(message.content);
      }
    }

    totalTokens += 2;
    return totalTokens;
  }

  free(): void {
    if (this.encoder) {
      this.encoder.free();
      this.encoder = null;
    }
  }
}

