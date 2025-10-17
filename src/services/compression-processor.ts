import { CompressionConfig } from '../types/index.js';
import { ChatMessage } from './prompt-processor.js';
import { TokenCounter } from './token-counter.js';
import { memoryLogger } from './logger.js';
import { modelDb, providerDb } from '../db/index.js';
import { decryptApiKey } from '../utils/crypto.js';

export interface CompressionContext {
  date: string;
  requestHeaders?: Record<string, string | string[] | undefined>;
}

const COMPRESSION_COUNT_MARKER = '[COMPRESSED:';
const PROGRESSIVE_INCREMENT = 10000;

export class CompressionProcessor {
  private tokenCounter: TokenCounter;

  constructor() {
    this.tokenCounter = new TokenCounter();
  }

  async processMessages(
    messages: ChatMessage[],
    compressionConfig: CompressionConfig,
    context: CompressionContext
  ): Promise<ChatMessage[]> {
    if (!compressionConfig.enabled) {
      return messages;
    }

    let totalTokens = this.getTokenCountFromHeaders(context.requestHeaders);
    totalTokens ??= this.tokenCounter.countMessagesTokens(messages);

    const messageCount = messages.filter(m => m.role !== 'system').length;
    const compressionCount = this.getCompressionCount(messages);
    const currentThreshold = compressionConfig.maxTokens + (compressionCount * PROGRESSIVE_INCREMENT);

    memoryLogger.debug(
      `压缩检查 | Token: ${totalTokens}/${currentThreshold} | 消息数: ${messageCount}/${compressionConfig.minMessages} | 已压缩次数: ${compressionCount}`,
      'CompressionProcessor'
    );

    if (totalTokens <= currentThreshold || messageCount <= compressionConfig.minMessages) {
      return messages;
    }

    memoryLogger.info(
      `触发压缩 | Token: ${totalTokens} | 阈值: ${currentThreshold} | 消息数: ${messageCount} | 第 ${compressionCount + 1} 次压缩`,
      'CompressionProcessor'
    );

    try {
      const compressedMessages = await this.compressMessages(
        messages,
        compressionConfig,
        context,
        compressionCount + 1
      );

      const newTotalTokens = this.tokenCounter.countMessagesTokens(compressedMessages);
      const compressionRate = ((1 - newTotalTokens / totalTokens) * 100).toFixed(1);

      memoryLogger.info(
        `压缩完成 | 原始: ${totalTokens} tokens | 压缩后: ${newTotalTokens} tokens | 压缩率: ${compressionRate}%`,
        'CompressionProcessor'
      );

      return compressedMessages;
    } catch (error: any) {
      memoryLogger.error(
        `压缩失败: ${error.message},保留原始消息`,
        'CompressionProcessor'
      );
      return messages;
    }
  }

  private getTokenCountFromHeaders(headers?: Record<string, string | string[] | undefined>): number | null {
    if (!headers) {
      return null;
    }

    const tokenCountHeader = headers['x-token-count'] || headers['X-Token-Count'];
    if (tokenCountHeader) {
      const value = Array.isArray(tokenCountHeader) ? tokenCountHeader[0] : tokenCountHeader;
      const count = parseInt(value, 10);
      if (!isNaN(count) && count > 0) {
        memoryLogger.debug(`使用 Header 提供的 Token 数量: ${count}`, 'CompressionProcessor');
        return count;
      }
    }

    return null;
  }

  private getCompressionCount(messages: ChatMessage[]): number {
    for (const msg of messages) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const escapedMarker = COMPRESSION_COUNT_MARKER.replace(/[[\]]/g, '\\$&');
        const match = msg.content.match(new RegExp(`${escapedMarker}(\\d+)\\]`));
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    }
    return 0;
  }

  private async compressMessages(
    messages: ChatMessage[],
    config: CompressionConfig,
    context: CompressionContext,
    compressionCount: number
  ): Promise<ChatMessage[]> {
    const systemMessages = messages.filter(m => m.role === 'system');
    const messagesWithoutSystem = messages.filter(m => m.role !== 'system');

    const { toCompress, toKeep } = this.splitMessagesByTokens(
      messagesWithoutSystem,
      config.keepRecentTokens
    );

    if (toCompress.length === 0) {
      memoryLogger.warn('没有可压缩的消息', 'CompressionProcessor');
      return messages;
    }

    if (!config.summaryModelId) {
      memoryLogger.warn('未配置摘要模型,跳过压缩', 'CompressionProcessor');
      return messages;
    }

    const summary = await this.generateLLMSummary(toCompress, config);

    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `${COMPRESSION_COUNT_MARKER}${compressionCount}] 以下是之前的对话摘要：\n\n${summary}`
    };

    const newMessages: ChatMessage[] = [];

    for (const sysMsg of systemMessages) {
      if (typeof sysMsg.content === 'string' && sysMsg.content.includes(COMPRESSION_COUNT_MARKER)) {
        continue;
      }
      newMessages.push(sysMsg);
    }

    newMessages.push(summaryMessage, ...toKeep);

    return newMessages;
  }

  private splitMessagesByTokens(
    messages: ChatMessage[],
    keepRecentTokens: number
  ): { toCompress: ChatMessage[], toKeep: ChatMessage[] } {
    let recentTokens = 0;
    let splitIndex = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.tokenCounter.countMessagesTokens([messages[i]]);

      if (recentTokens + msgTokens > keepRecentTokens) {
        splitIndex = i + 1;
        break;
      }

      recentTokens += msgTokens;
    }

    if (splitIndex === 0) {
      splitIndex = 1;
    }

    return {
      toCompress: messages.slice(0, splitIndex),
      toKeep: messages.slice(splitIndex)
    };
  }

  private async generateLLMSummary(
    messages: ChatMessage[],
    config: CompressionConfig
  ): Promise<string> {
    const model = modelDb.getById(config.summaryModelId!);
    if (!model) {
      throw new Error(`摘要模型不存在: ${config.summaryModelId}`);
    }

    const provider = model.provider_id ? providerDb.getById(model.provider_id) : null;
    if (!provider) {
      throw new Error(`摘要模型的提供商不存在`);
    }

    if (!provider.base_url || provider.base_url.trim() === '') {
      throw new Error(`摘要模型提供商的 base_url 未配置`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(provider.base_url);
    } catch (e) {
      const error = e as Error;
      throw new Error(`摘要模型提供商的 base_url 格式无效: ${provider.base_url} - ${error.message}`);
    }

    const hostname = parsedUrl.hostname || '';
    const isPrivateNetwork = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|::1|fc00:|fd00:)/.test(hostname);
    if (isPrivateNetwork) {
      throw new Error(`摘要模型提供商的 base_url 指向内部网络，不允许访问: ${provider.base_url}`);
    }

    const historyText = this.formatMessagesForSummary(messages);
    const summaryPrompt = config.summaryPrompt || this.getDefaultSummaryPrompt(config.compressionRatio);
    const prompt = summaryPrompt.replace('{{history}}', historyText);

    const apiKey = decryptApiKey(provider.api_key);
    const endpoint = `${provider.base_url}/chat/completions`;

    const targetTokens = Math.floor(
      this.tokenCounter.countMessagesTokens(messages) * config.compressionRatio
    );

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.model_identifier,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: Math.max(targetTokens, 500),
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM 摘要生成失败: HTTP ${response.status} - ${errorText}`);
    }

    const data: any = await response.json();
    const summary = data?.choices?.[0]?.message?.content;

    if (!summary) {
      throw new Error('LLM 返回的摘要为空');
    }

    return summary;
  }

  private formatMessagesForSummary(messages: ChatMessage[]): string {
    return messages.map(msg => {
      const content = typeof msg.content === 'string' ? msg.content : '';
      return `${msg.role}: ${content}`;
    }).join('\n\n');
  }

  private getDefaultSummaryPrompt(compressionRatio: number): string {
    const targetPercentage = Math.round(compressionRatio * 100);
    return `你是一个专业的对话摘要助手。请将以下对话历史压缩成简洁的摘要，目标长度约为原文的 ${targetPercentage}%。

核心原则：
1. 完整保留所有可能与问题相关的代码片段、日志信息、错误信息、配置内容
2. 对于明确已经无关或过时的代码/内容，使用 "..." 省略
3. 保留用户的主要需求、目标和待解决的问题，以及可能需要的技术支持
4. 保留已经做出的重要决策和结论

压缩策略：
- 使用第三人称客观描述对话过程
- 保持时间顺序和逻辑连贯性
- 对于可能在后续对话中被引用的代码、日志、配置等，必须完整保留
- 对于已明确废弃、替换或无关的内容，用 "..." 简化
- 示例：
  * 保留："用户修改了配置文件 config.json，将 maxTokens 从 10000 改为 30000"
  * 省略："用户尝试了多种方案但都失败了，最终采用了方案 C ... (省略失败的方案 A、B 细节)"

对话历史：
{{history}}

请生成摘要：`;
  }

  parseCompressionConfig(configJson: string | null): CompressionConfig | null {
    if (!configJson) {
      return null;
    }

    try {
      const config = JSON.parse(configJson);

      const maxTokens = config.maxTokens || 30000;
      const minMessages = config.minMessages || 4;
      const keepRecentTokens = config.keepRecentTokens || 10000;
      const compressionRatio = config.compressionRatio || 0.3;

      if (maxTokens <= 0 || maxTokens > 1000000) {
        throw new Error('maxTokens 必须在 1-1000000 之间');
      }

      if (minMessages < 1 || minMessages > 1000) {
        throw new Error('minMessages 必须在 1-1000 之间');
      }

      if (keepRecentTokens <= 0 || keepRecentTokens > 1000000) {
        throw new Error('keepRecentTokens 必须在 1-1000000 之间');
      }

      if (compressionRatio <= 0 || compressionRatio > 1) {
        throw new Error('compressionRatio 必须在 0-1 之间');
      }

      return {
        enabled: config.enabled !== false,
        maxTokens,
        minMessages,
        keepRecentTokens,
        compressionRatio,
        summaryModelId: config.summaryModelId,
        summaryPrompt: config.summaryPrompt,
      };
    } catch (error: any) {
      memoryLogger.error(`解析压缩配置失败: ${error.message}`, 'CompressionProcessor');
      return null;
    }
  }
}

export const compressionProcessor = new CompressionProcessor();

