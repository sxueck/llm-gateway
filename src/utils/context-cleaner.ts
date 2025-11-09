import { memoryLogger } from '../services/logger.js';
import { ExpertTarget } from '../types/expert-routing.js';

interface ChatMessage {
  role: string;
  content: string | any;
  tool_calls?: any[];
  thinking_blocks?: any[];
  reasoning_content?: string;
  [key: string]: any;
}

export class ContextCleaner {
  cleanMessagesForExpert(
    messages: ChatMessage[],
    targetExpert: ExpertTarget,
    sourceExpert?: ExpertTarget
  ): ChatMessage[] {
    const targetCapabilities = targetExpert.capabilities;
    const sourceCapabilities = sourceExpert?.capabilities;

    const needsCleaning =
      sourceCapabilities?.supportsReasoning &&
      !targetCapabilities?.supportsReasoning;

    if (!needsCleaning) {
      memoryLogger.debug(
        `上下文清洗: 跳过 | 目标专家支持推理过程`,
        'ContextCleaner'
      );
      return messages;
    }

    memoryLogger.info(
      `上下文清洗: 开始 | 源专家=${sourceExpert?.category || 'unknown'} | 目标专家=${targetExpert.category}`,
      'ContextCleaner'
    );

    const cleanedMessages = messages.map(msg => this.cleanMessage(msg));

    const cleanedCount = cleanedMessages.filter((msg, idx) =>
      msg !== messages[idx]
    ).length;

    memoryLogger.info(
      `上下文清洗: 完成 | 清洗消息数=${cleanedCount}/${messages.length}`,
      'ContextCleaner'
    );

    return cleanedMessages;
  }

  private cleanMessage(msg: ChatMessage): ChatMessage {
    if (msg.role !== 'assistant') {
      return msg;
    }

    return this.cleanAssistantMessage(msg);
  }

  private cleanAssistantMessage(msg: ChatMessage): ChatMessage {
    const cleaned = { ...msg };

    if (typeof cleaned.content === 'string') {
      const originalContent = cleaned.content;
      cleaned.content = this.removeThinkTags(cleaned.content);

      if (cleaned.content !== originalContent) {
        memoryLogger.debug(
          `移除推理标签 | 原始长度=${originalContent.length} | 清洗后长度=${cleaned.content.length}`,
          'ContextCleaner'
        );
      }
    }

    if (cleaned.thinking_blocks) {
      delete cleaned.thinking_blocks;
    }

    if (cleaned.reasoning_content) {
      delete cleaned.reasoning_content;
    }

    return cleaned;
  }

  removeThinkTags(content: string): string {
    if (!content) return content;

    const cleaned = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    
    return cleaned;
  }

  removeThinkTagsFromDelta(delta: any): any {
    if (!delta || !delta.content) {
      return delta;
    }

    const cleaned = { ...delta };
    cleaned.content = this.removeThinkTags(delta.content);
    
    return cleaned;
  }

  shouldFilterThinkingOutput(modelAttributes?: any): boolean {
    return modelAttributes?.supports_interleaved_thinking === true;
  }
}

export const contextCleaner = new ContextCleaner();

