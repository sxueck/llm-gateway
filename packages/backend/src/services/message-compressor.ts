import crypto from 'crypto';
import { memoryLogger } from './logger.js';
import { countMessagesCooperatively } from './token-counter.js';

// 配置常量
const MIN_CODE_LENGTH = parseInt(process.env.MIN_CODE_LENGTH || '100', 10);
const MIN_TEXT_LENGTH = parseInt(process.env.MIN_TEXT_LENGTH || '200', 10);
const KEEP_RECENT_MESSAGES = parseInt(process.env.KEEP_RECENT_MESSAGES || '5', 10);
// 会话级预压缩缓存：按"首条历史消息哈希"定位会话，命中后仅处理新增消息。
// 容量与 TTL 防止内存无限增长；进程重启后缓存清空、首次请求全量重建。
const CACHE_MAX_CONVERSATIONS = parseInt(process.env.MESSAGE_COMPRESSION_CACHE_SIZE || '256', 10);
const CACHE_TTL_MS = parseInt(process.env.MESSAGE_COMPRESSION_CACHE_TTL_MS || String(30 * 60 * 1000), 10);
const CACHE_MAX_VARIANTS_PER_KEY = 2;

/** 压缩只作用于历史窗口：最近 KEEP_RECENT_MESSAGES 条始终原样保留（阈值判断复用同一口径） */
export const KEEP_RECENT_WINDOW = KEEP_RECENT_MESSAGES;

interface MessageContent {
  role: string;
  content: string | any;
  [key: string]: any;
}

interface CompressionStats {
  originalMessageCount: number;
  compressedMessageCount: number;
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  duplicatesFound: number;
  compressionRatio: number;
}

export interface CompressionTiming {
  preprocessMs: number;
  tokenCountMs: number;
  totalMs: number;
}

export interface CompressionCacheInfo {
  hit: boolean;
  reusedMessages: number;
}

export interface CompressionResult {
  messages: MessageContent[];
  stats: CompressionStats;
  timing: CompressionTiming;
  cache: CompressionCacheInfo;
}

/**
 * 单个会话的增量压缩状态。
 *
 * 关键不变量：重复块保留"首次出现"的完整内容，后续出现替换为 [... #首次出现索引]。
 * 因此每条历史消息的压缩形态只取决于它自身和更早的消息（历史是前缀切片），
 * 追加式对话下压缩结果逐字节稳定 —— 上游 provider 的前缀缓存不会被逐轮破坏。
 */
interface ConversationCacheEntry {
  key: string;
  /** 每条原始历史消息的哈希，用于前缀校验（客户端编辑历史时缓存失效） */
  messageHashes: string[];
  /** 与 messageHashes 对齐的压缩后历史消息 */
  compressedMessages: MessageContent[];
  /** blockHash -> 首次出现的历史索引，append-only，一旦写入不再变化 */
  firstOccurrences: Map<string, number>;
  duplicatesFound: number;
  /** 历史部分的逐消息 token 帧总数（不含数组级 +2 修正），供增量统计复用 */
  originalHistoryFrames: number;
  compressedHistoryFrames: number;
  /** 绝对时间戳，TTL/LRU 依据 */
  lastAccess: number;
}

export class MessageCompressor {
  private readonly MIN_CODE_LENGTH = MIN_CODE_LENGTH;
  private readonly MIN_TEXT_LENGTH = MIN_TEXT_LENGTH;
  private readonly KEEP_RECENT_MESSAGES = KEEP_RECENT_MESSAGES;

  private readonly cache = new Map<string, ConversationCacheEntry[]>();
  /** 同一会话的并发请求串行化，避免增量写入交错导致缓存状态错乱 */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly configFingerprint = `${MIN_CODE_LENGTH}|${MIN_TEXT_LENGTH}|${KEEP_RECENT_MESSAGES}`;

  async compressMessages(messages: MessageContent[]): Promise<CompressionResult> {
    const startTime = performance.now();
    // 如果消息数量不足以进行压缩（需要至少比保留数量多1条），则直接返回
    if (!messages || messages.length <= this.KEEP_RECENT_MESSAGES) {
      return {
        messages,
        stats: this.createEmptyStats(messages ? messages.length : 0),
        timing: { preprocessMs: 0, tokenCountMs: 0, totalMs: performance.now() - startTime },
        cache: { hit: false, reusedMessages: 0 }
      };
    }

    const recentMessages = messages.slice(-this.KEEP_RECENT_MESSAGES);
    const historyMessages = messages.slice(0, messages.length - this.KEEP_RECENT_MESSAGES);
    const historyHashes = historyMessages.map(msg => this.generateHash(JSON.stringify(msg)));
    const cacheKey = this.generateHash(`${this.configFingerprint}\n${historyHashes[0]}`);

    const result = await this.withLock(cacheKey, async () => {
      const preprocessStart = performance.now();

      let entry = this.findReusableEntry(cacheKey, historyHashes);
      const reusedMessages = entry ? entry.messageHashes.length : 0;
      if (entry) {
        entry.lastAccess = Date.now();
      } else {
        entry = this.createEntry(cacheKey);
        this.storeEntry(cacheKey, entry);
      }

      // 只处理缓存未覆盖的增量历史消息；历史是前缀切片，且压缩形态只依赖更早
      // 的消息，所以增量结果与全量重算逐字节一致。
      const newMessages = historyMessages.slice(reusedMessages);
      const newCompressed = this.compressNewHistoryMessages(
        entry,
        newMessages,
        reusedMessages,
        historyHashes.slice(reusedMessages)
      );

      const compressedMessages = [...entry.compressedMessages, ...recentMessages];
      const preprocessMs = performance.now() - preprocessStart;

      const tokenCountStart = performance.now();
      const stats = await this.calculateStats(entry, newMessages, newCompressed, recentMessages, messages.length);
      const tokenCountMs = performance.now() - tokenCountStart;

      return {
        messages: compressedMessages,
        stats,
        timing: { preprocessMs, tokenCountMs, totalMs: performance.now() - startTime },
        cache: { hit: reusedMessages > 0, reusedMessages }
      };
    });

    memoryLogger.info(
      `消息压缩完成 | 原始: ${result.stats.originalMessageCount} 条 | 压缩后: ${result.stats.compressedMessageCount} 条 | ` +
      `去重: ${result.stats.duplicatesFound} 个 | Token保留率: ${(result.stats.compressionRatio * 100).toFixed(1)}% | ` +
      `缓存: ${result.cache.hit ? `命中,复用 ${result.cache.reusedMessages} 条历史` : '未命中'} | 耗时: ${result.timing.totalMs.toFixed(1)}ms`,
      'MessageCompressor'
    );

    return result;
  }

  private createEntry(key: string): ConversationCacheEntry {
    return {
      key,
      messageHashes: [],
      compressedMessages: [],
      firstOccurrences: new Map(),
      duplicatesFound: 0,
      originalHistoryFrames: 0,
      compressedHistoryFrames: 0,
      lastAccess: Date.now()
    };
  }

  /** 找到与当前历史前缀匹配的缓存条目；顺带清理过期条目 */
  private findReusableEntry(key: string, historyHashes: string[]): ConversationCacheEntry | undefined {
    const bucket = this.cache.get(key);
    if (!bucket) return undefined;

    const now = Date.now();
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (now - bucket[i].lastAccess > CACHE_TTL_MS) {
        bucket.splice(i, 1);
        continue;
      }
      if (this.isPrefixMatch(bucket[i].messageHashes, historyHashes)) {
        return bucket[i];
      }
    }
    if (bucket.length === 0) this.cache.delete(key);
    return undefined;
  }

  private isPrefixMatch(stored: string[], current: string[]): boolean {
    if (stored.length === 0 || stored.length > current.length) return false;
    for (let i = 0; i < stored.length; i++) {
      if (stored[i] !== current[i]) return false;
    }
    return true;
  }

  private storeEntry(key: string, entry: ConversationCacheEntry): void {
    let bucket = this.cache.get(key);
    if (!bucket) {
      bucket = [];
      this.cache.set(key, bucket);
    }
    bucket.push(entry);
    while (bucket.length > CACHE_MAX_VARIANTS_PER_KEY) bucket.shift();

    // simple: 全局容量超限时 O(n) 扫描逐出最久未用条目，规模 <=256 足够
    while (this.countEntries() > CACHE_MAX_CONVERSATIONS) {
      let oldestKey: string | null = null;
      let oldestIdx = -1;
      let oldestTs = Infinity;
      for (const [k, b] of this.cache) {
        for (let i = 0; i < b.length; i++) {
          if (b[i].lastAccess < oldestTs) {
            oldestTs = b[i].lastAccess;
            oldestKey = k;
            oldestIdx = i;
          }
        }
      }
      if (!oldestKey) break;
      const bucketToTrim = this.cache.get(oldestKey)!;
      bucketToTrim.splice(oldestIdx, 1);
      if (bucketToTrim.length === 0) this.cache.delete(oldestKey);
    }
  }

  private countEntries(): number {
    let n = 0;
    for (const bucket of this.cache.values()) n += bucket.length;
    return n;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail: Promise<void> = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /**
   * 增量压缩新进入历史窗口的消息，并提交到缓存条目。
   * 同步执行（无 await），配合外层 per-key 锁保证状态一致性。
   */
  private compressNewHistoryMessages(
    entry: ConversationCacheEntry,
    newMessages: MessageContent[],
    startIndex: number,
    newHashes: string[]
  ): MessageContent[] {
    const compressed: MessageContent[] = [];
    let duplicates = 0;

    newMessages.forEach((msg, offset) => {
      const index = startIndex + offset;
      const { message, duplicatesFound } = this.compressSingleMessage(msg, index, entry.firstOccurrences);
      duplicates += duplicatesFound;
      compressed.push(message);
    });

    entry.messageHashes.push(...newHashes);
    entry.compressedMessages.push(...compressed);
    entry.duplicatesFound += duplicates;
    return compressed;
  }

  /**
   * 压缩单条消息：提取代码块/文本块，首次出现的块登记索引并保留原文，
   * 重复块替换为指向首次出现的引用 [... #n]。
   * 数组 content 按文本 part 逐段替换，图片等非文本 part 原样保留。
   */
  private compressSingleMessage(
    msg: MessageContent,
    index: number,
    firstOccurrences: Map<string, number>
  ): { message: MessageContent; duplicatesFound: number } {
    if (typeof msg.content === 'string') {
      if (!msg.content) return { message: msg, duplicatesFound: 0 };

      const replacements = this.collectReplacements(msg.content, index, firstOccurrences);
      let out = msg.content;
      for (const { content, replacement } of replacements) {
        if (out.includes(content)) out = out.replace(content, replacement);
      }
      if (out === msg.content) return { message: msg, duplicatesFound: replacements.length };

      if (out.trim().length === 0) {
        memoryLogger.warn(`压缩后消息 #${index + 1} 内容为空，保留原始消息`, 'MessageCompressor');
        return { message: msg, duplicatesFound: replacements.length };
      }
      if (replacements.length > 0) {
        memoryLogger.debug(`压缩消息 #${index + 1} | 替换 ${replacements.length} 个重复块`, 'MessageCompressor');
      }
      return { message: { ...msg, content: out }, duplicatesFound: replacements.length };
    }

    if (Array.isArray(msg.content)) {
      let changed = false;
      let duplicatesFound = 0;
      const newParts = msg.content.map(part => {
        if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
          return part;
        }
        const replacements = this.collectReplacements(part.text, index, firstOccurrences);
        duplicatesFound += replacements.length;
        let out = part.text;
        for (const { content, replacement } of replacements) {
          if (out.includes(content)) out = out.replace(content, replacement);
        }
        if (out === part.text) return part;
        changed = true;
        return { ...part, text: out };
      });
      if (!changed) return { message: msg, duplicatesFound };

      // 所有文本 part 都被压空时保留原始消息，避免丢失非文本内容
      const textParts = newParts.filter(p => p && p.type === 'text');
      if (textParts.length > 0 && textParts.every(p => typeof p.text !== 'string' || p.text.trim().length === 0)) {
        memoryLogger.warn(`压缩后消息 #${index + 1} 文本内容为空，保留原始消息`, 'MessageCompressor');
        return { message: msg, duplicatesFound };
      }
      return { message: { ...msg, content: newParts }, duplicatesFound };
    }

    // 非法/非标准 content 类型（null、对象等）不做压缩，原样透传
    return { message: msg, duplicatesFound: 0 };
  }

  /**
   * 提取文本中的可压缩块，登记首次出现索引，返回需要替换的重复块列表。
   * 同一消息内出现的相同块不互相替换（与旧实现一致），只跨消息去重。
   */
  private collectReplacements(
    text: string,
    index: number,
    firstOccurrences: Map<string, number>
  ): Array<{ content: string; replacement: string; length: number }> {
    const replacements: Array<{ content: string; replacement: string; length: number }> = [];
    const seenInThisMessage = new Set<string>();

    for (const block of this.extractBlocks(text)) {
      const hash = this.generateHash(block);
      if (seenInThisMessage.has(hash)) continue;
      seenInThisMessage.add(hash);

      const first = firstOccurrences.get(hash);
      if (first === undefined) {
        firstOccurrences.set(hash, index);
      } else if (first < index) {
        replacements.push({
          content: block,
          replacement: `[... #${first + 1}]`,
          length: block.length
        });
      }
    }

    replacements.sort((a, b) => b.length - a.length);
    return replacements;
  }

  /** 提取全部可压缩块：完整围栏代码块 + 内部代码/XML/environment_details 内容 */
  private extractBlocks(text: string): string[] {
    const blocks: string[] = [];
    for (const fenced of this.extractCodeBlocks(text)) {
      if (fenced.length >= this.MIN_CODE_LENGTH) blocks.push(fenced);
    }
    for (const inner of this.extractTextBlocks(text)) {
      if (inner.length >= this.MIN_TEXT_LENGTH) blocks.push(inner);
    }
    return blocks;
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
      const startIdx = text.indexOf('```', i);
      if (startIdx === -1) break;

      const endIdx = text.indexOf('```', startIdx + 3);
      if (endIdx === -1) break;

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

      const sections = this.extractSectionsByHash(envContent);

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

  /**
   * 生成内容哈希 - 完全匹配，不做标准化（指纹用途，非安全场景）
   */
  private generateHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // Token 计数复用缓存的逐消息帧数，只对增量消息和新近窗口计数；
  // countMessagesCooperatively 每次调用附带 +2 数组级修正，帧数求和时扣除。
  private async calculateStats(
    entry: ConversationCacheEntry,
    newMessages: MessageContent[],
    newCompressed: MessageContent[],
    recentMessages: MessageContent[],
    originalMessageCount: number
  ): Promise<CompressionStats> {
    const [newOriginalFrames, newCompressedFrames, recentTokens] = await Promise.all([
      this.countFrames(newMessages),
      this.countFrames(newCompressed),
      countMessagesCooperatively(recentMessages)
    ]);
    entry.originalHistoryFrames += newOriginalFrames;
    entry.compressedHistoryFrames += newCompressedFrames;

    const originalTokens = entry.originalHistoryFrames + recentTokens;
    const compressedTokens = entry.compressedHistoryFrames + recentTokens;

    return {
      originalMessageCount,
      compressedMessageCount: entry.compressedMessages.length + recentMessages.length,
      originalTokenEstimate: originalTokens,
      compressedTokenEstimate: compressedTokens,
      duplicatesFound: entry.duplicatesFound,
      compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1
    };
  }

  private async countFrames(messages: MessageContent[]): Promise<number> {
    if (!messages || messages.length === 0) return 0;
    return (await countMessagesCooperatively(messages)) - 2;
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
