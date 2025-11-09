import crypto from 'crypto';
import { memoryLogger } from './logger.js';
import { countTokensForMessages } from './token-counter.js';

// 配置常量
const MIN_CODE_LENGTH = parseInt(process.env.MIN_CODE_LENGTH || '100', 10);
const MIN_TEXT_LENGTH = parseInt(process.env.MIN_TEXT_LENGTH || '200', 10);

interface MessageContent {
  role: string;
  content: string | any;
  [key: string]: any;
}

interface ContentFingerprint {
  hash: string;
  content: string;
  messageIndex: number;
  contentType: 'code' | 'text-block';
  length: number;
}

interface CompressionStats {
  originalMessageCount: number;
  compressedMessageCount: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  duplicatesFound: number;
  compressionRatio: number;
}

export class MessageCompressor {
  private readonly MIN_CODE_LENGTH = MIN_CODE_LENGTH;
  private readonly MIN_TEXT_LENGTH = MIN_TEXT_LENGTH;

  compressMessages(messages: MessageContent[]): { messages: MessageContent[]; stats: CompressionStats } {
    if (!messages || messages.length < 3) {
      return {
        messages,
        stats: this.createEmptyStats(messages.length)
      };
    }

    const startTime = Date.now();
    const originalMessages = [...messages];
    const lastTwoMessages = messages.slice(-2);
    const historyMessages = messages.slice(0, -2);

    const fingerprints = this.extractFingerprints(historyMessages);
    const compressedHistory = this.compressHistoryMessages(historyMessages, fingerprints);
    const compressedMessages = [...compressedHistory, ...lastTwoMessages];

    const stats = this.calculateStats(originalMessages, compressedMessages, fingerprints);
    const duration = Date.now() - startTime;

    memoryLogger.info(
      `消息压缩完成 | 原始: ${stats.originalMessageCount} 条 | 压缩后: ${stats.compressedMessageCount} 条 | ` +
      `去重: ${stats.duplicatesFound} 个 | Token保留率: ${(stats.compressionRatio * 100).toFixed(1)}% | 耗时: ${duration}ms`,
      'MessageCompressor'
    );

    return { messages: compressedMessages, stats };
  }

  private extractFingerprints(messages: MessageContent[]): Map<string, ContentFingerprint[]> {
    const fingerprintMap = new Map<string, ContentFingerprint[]>();

    messages.forEach((msg, index) => {
      const textContent = this.extractTextContent(msg.content);
      if (!textContent) return;

      const codeBlocks = this.extractCodeBlocks(textContent);
      codeBlocks.forEach(code => {
        if (code.length >= this.MIN_CODE_LENGTH) {
          const hash = this.generateHash(code);
          const fingerprint: ContentFingerprint = {
            hash,
            content: code,
            messageIndex: index,
            contentType: 'code',
            length: code.length
          };
          this.addFingerprint(fingerprintMap, hash, fingerprint);
        }
      });

      const textBlocks = this.extractTextBlocks(textContent);
      textBlocks.forEach(block => {
        if (block.length >= this.MIN_TEXT_LENGTH) {
          const hash = this.generateHash(block);
          const fingerprint: ContentFingerprint = {
            hash,
            content: block,
            messageIndex: index,
            contentType: 'text-block',
            length: block.length
          };
          this.addFingerprint(fingerprintMap, hash, fingerprint);
        }
      });
    });

    return fingerprintMap;
  }

  private compressHistoryMessages(
    messages: MessageContent[],
    fingerprints: Map<string, ContentFingerprint[]>
  ): MessageContent[] {
    const compressedMessages: MessageContent[] = [];

    messages.forEach((msg, index) => {
      const textContent = this.extractTextContent(msg.content);
      if (!textContent) {
        compressedMessages.push(msg);
        return;
      }

      let compressedContent = textContent;
      let compressionCount = 0;
      const replacements: Array<{ content: string; replacement: string; length: number }> = [];

      for (const [, prints] of fingerprints.entries()) {
        if (prints.length <= 1) continue;

        const currentPrint = prints.find(p => p.messageIndex === index);
        if (!currentPrint) continue;

        const lastOccurrence = prints[prints.length - 1];
        if (lastOccurrence.messageIndex === index) continue;

        const referenceMsg = `[... #${lastOccurrence.messageIndex + 1}]`;

        replacements.push({
          content: currentPrint.content,
          replacement: referenceMsg,
          length: currentPrint.content.length
        });
      }

      replacements.sort((a, b) => b.length - a.length);

      for (const { content, replacement } of replacements) {
        if (compressedContent.includes(content)) {
          compressedContent = compressedContent.replace(content, replacement);
          compressionCount++;

          memoryLogger.debug(
            `压缩消息 #${index + 1} | 长度: ${content.length} -> ${replacement.length}`,
            'MessageCompressor'
          );
        }
      }

      const finalContent = compressionCount > 0 ? compressedContent : msg.content;

      if (typeof finalContent === 'string' && finalContent.trim().length === 0) {
        memoryLogger.warn(
          `压缩后消息 #${index + 1} 内容为空，保留原始消息`,
          'MessageCompressor'
        );
        compressedMessages.push(msg);
      } else {
        compressedMessages.push({
          ...msg,
          content: finalContent
        });
      }
    });

    return compressedMessages;
  }

  /**
   * 高效提取代码块 - 使用字符串解析替代正则表达式
   * 时间复杂度: O(n)，空间复杂度: O(k) 其中 k 是代码块数量
   */
  private extractCodeBlocks(text: string): string[] {
    const codeBlocks: string[] = [];
    let i = 0;
    const len = text.length;
    
    while (i < len) {
      // 查找代码块开始标记
      const startIdx = text.indexOf('```', i);
      if (startIdx === -1) break;
      
      // 查找代码块结束标记
      const endIdx = text.indexOf('```', startIdx + 3);
      if (endIdx === -1) break;
      
      // 提取代码块（包含标记）
      const codeBlock = text.substring(startIdx, endIdx + 3);
      codeBlocks.push(codeBlock);
      
      i = endIdx + 3;
    }
    
    return codeBlocks;
  }

  /**
   * 提取文本块 - 提取代码块内部的实际代码内容和XML标签包裹的内容
   * 支持：
   * 1. Markdown代码块内的代码内容（不包括```和语言标识）
   * 2. <augment_code_snippet>标签包裹的完整内容
   * 3. <file_content>标签包裹的完整内容
   * 4. <content>标签包裹的完整内容
   * 5. <environment_details>标签中的文件列表部分
   */
  private extractTextBlocks(text: string): string[] {
    const blocks: string[] = [];

    let i = 0;
    const len = text.length;
    while (i < len) {
      const startIdx = text.indexOf('```', i);
      if (startIdx === -1) break;

      const langEndIdx = text.indexOf('\n', startIdx + 3);
      if (langEndIdx === -1) break;

      const endIdx = text.indexOf('```', langEndIdx);
      if (endIdx === -1) break;

      const codeContent = text.substring(langEndIdx + 1, endIdx).trim();
      if (codeContent.length >= this.MIN_TEXT_LENGTH) {
        blocks.push(codeContent);
      }

      i = endIdx + 3;
    }

    const xmlTags = [
      { start: '<augment_code_snippet', end: '</augment_code_snippet>' },
      { start: '<file_content', end: '</file_content>' },
      { start: '<content', end: '</content>' }
    ];

    for (const tag of xmlTags) {
      i = 0;
      while (i < len) {
        const startIdx = text.indexOf(tag.start, i);
        if (startIdx === -1) break;

        const tagEndIdx = text.indexOf('>', startIdx);
        if (tagEndIdx === -1) break;

        const closeIdx = text.indexOf(tag.end, tagEndIdx);
        if (closeIdx === -1) break;

        const tagContent = text.substring(startIdx, closeIdx + tag.end.length);
        if (tagContent.length >= this.MIN_TEXT_LENGTH) {
          blocks.push(tagContent);
        }

        i = closeIdx + tag.end.length;
      }
    }

    // 提取 environment_details 中的文件列表部分
    const envDetailsBlocks = this.extractEnvironmentDetailsFileList(text);
    blocks.push(...envDetailsBlocks);

    return blocks;
  }

  /**
   * 提取 environment_details 中以 # 为边界的各个部分
   * 支持提取所有 # 开头的部分（如 VSCode Visible Files、Current Workspace Directory 等）
   * 并对提取的内容进行去重
   */
  private extractEnvironmentDetailsFileList(text: string): string[] {
    const blocks: string[] = [];
    const seenHashes = new Set<string>();
    let i = 0;
    const len = text.length;

    while (i < len) {
      const envStartIdx = text.indexOf('<environment_details>', i);
      if (envStartIdx === -1) break;

      const envEndIdx = text.indexOf('</environment_details>', envStartIdx);
      if (envEndIdx === -1) break;

      const envContent = text.substring(envStartIdx, envEndIdx + '</environment_details>'.length);

      // 提取所有以 # 开头的部分
      const sections = this.extractSectionsByHash(envContent);
      
      // 对每个部分进行去重并添加到结果中
      for (const section of sections) {
        if (section.length >= this.MIN_TEXT_LENGTH) {
          const hash = this.generateHash(section);
          if (!seenHashes.has(hash)) {
            seenHashes.add(hash);
            blocks.push(section);
          }
        }
      }

      i = envEndIdx + '</environment_details>'.length;
    }

    return blocks;
  }

  /**
   * 提取文本中所有以 # 为边界的部分
   * 每个部分从 # 开始，到下一个 # 或文本结束为止
   */
  private extractSectionsByHash(text: string): string[] {
    const sections: string[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
      // 查找以 # 开头的行
      const hashIdx = text.indexOf('\n#', i);
      if (hashIdx === -1) break;

      // 从 # 开始的位置
      const sectionStart = hashIdx + 1;

      // 查找下一个 # 或标签结束
      let sectionEnd = text.indexOf('\n#', sectionStart + 1);
      if (sectionEnd === -1) {
        // 如果没有下一个 #，查找标签结束
        sectionEnd = text.indexOf('</environment_details>', sectionStart);
        if (sectionEnd === -1) {
          sectionEnd = len;
        }
      }

      const section = text.substring(sectionStart, sectionEnd).trim();
      if (section.length > 0) {
        sections.push(section);
      }

      i = sectionEnd;
    }

    return sections;
  }

  private extractTextContent(content: string | any): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join('\n');
    }

    if (content && typeof content === 'object') {
      return JSON.stringify(content);
    }

    return '';
  }

  /**
   * 生成内容哈希 - 完全匹配，不做标准化
   */
  private generateHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private addFingerprint(
    map: Map<string, ContentFingerprint[]>,
    hash: string,
    fingerprint: ContentFingerprint
  ): void {
    const existing = map.get(hash) || [];
    existing.push(fingerprint);
    map.set(hash, existing);
  }

  private calculateStats(
    original: MessageContent[],
    compressed: MessageContent[],
    fingerprints: Map<string, ContentFingerprint[]>
  ): CompressionStats {
    const originalTokens = this.estimateTokens(original);
    const compressedTokens = this.estimateTokens(compressed);
    
    let duplicatesFound = 0;
    for (const prints of fingerprints.values()) {
      if (prints.length > 1) {
        duplicatesFound += prints.length - 1;
      }
    }

    return {
      originalMessageCount: original.length,
      compressedMessageCount: compressed.length,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: compressedTokens,
      duplicatesFound,
      compressionRatio: compressedTokens / originalTokens
    };
  }

  private estimateTokens(messages: MessageContent[]): number {
    return countTokensForMessages(messages);
  }

  private createEmptyStats(messageCount: number): CompressionStats {
    return {
      originalMessageCount: messageCount,
      compressedMessageCount: messageCount,
      originalTokenEstimate: 0,
      compressedTokenEstimate: 0,
      duplicatesFound: 0,
      compressionRatio: 1.0
    };
  }


}

export const messageCompressor = new MessageCompressor();

