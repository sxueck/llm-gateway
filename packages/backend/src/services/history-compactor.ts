import crypto from "node:crypto";
import { memoryLogger } from "./logger.js";
import { countTokensForMessages } from "./token-counter.js";
import { buildChatCompletionsEndpoint } from "../utils/api-endpoint-builder.js";
import { upstreamFetch } from "../utils/upstream-fetch.js";

const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_MAX_TOKENS = 2048;
// 单条消息进入摘要 prompt 的上限：巨型工具输出只保留头部，避免撑爆 summarizer 输入
const MESSAGE_SNIPPET_CHARS = 6000;

const SUMMARIZER_SYSTEM_PROMPT = `You compress long LLM conversations into a compact handoff summary inside an API gateway. Merge the previous summary (if any) and the new messages into one updated summary. Preserve: user goals and constraints, key decisions with their rationale, important facts and identifiers, file/resource state changes, errors and unresolved issues, and immediate next steps. Drop pleasantries and redundant detail. Output plain text with short bullet sections. Reply with the summary only.`;

export interface CompactorConfig {
  enabled: boolean;
  thresholdTokens: number;
  keepRecent: number;
  minDeltaTokens: number;
  model: string;
  baseUrl: string;
  apiKey: string;
  cacheSize: number;
  cacheTtlMs: number;
}

export function compactorConfigFromEnv(): CompactorConfig {
  return {
    enabled: process.env.COMPACT_ENABLED !== "0",
    thresholdTokens: parseInt(
      process.env.COMPACT_THRESHOLD_TOKENS || "32768",
      10,
    ),
    keepRecent: parseInt(process.env.COMPACT_KEEP_RECENT || "6", 10),
    minDeltaTokens: parseInt(
      process.env.COMPACT_MIN_DELTA_TOKENS || "4096",
      10,
    ),
    model: process.env.COMPACT_MODEL || "",
    baseUrl: process.env.COMPACT_BASE_URL || "",
    apiKey: process.env.COMPACT_API_KEY || "",
    cacheSize: parseInt(process.env.COMPACT_CACHE_SIZE || "256", 10),
    cacheTtlMs: parseInt(
      process.env.COMPACT_CACHE_TTL_MS || String(30 * 60 * 1000),
      10,
    ),
  };
}

/**
 * 单会话的滚动摘要状态。
 *
 * hashes 是"已并入摘要"的原始历史消息哈希前缀。客户端每轮重发全量历史，
 * 前缀切片保证增量合并只依赖更早消息；客户端编辑历史时前缀失配、缓存整体重建。
 */
interface ConversationEntry {
  hashes: string[];
  summary: string;
  /** 绝对时间戳，TTL/LRU 依据 */
  lastAccess: number;
}

export interface CompactionResult {
  messages: any[];
  /** 是否发生了替换（历史超过阈值） */
  fired: boolean;
  /** 本次是否调用了 LLM 更新摘要（false 表示复用缓存摘要 + 未合并增量原样下发） */
  merged: boolean;
  originalTokens: number;
  compactedTokens: number;
}

export class HistoryCompactor {
  private readonly config: CompactorConfig;
  private readonly cache = new Map<string, ConversationEntry>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(config: CompactorConfig = compactorConfigFromEnv()) {
    this.config = config;
    if (config.enabled && !(config.model && config.baseUrl && config.apiKey)) {
      memoryLogger.warn(
        "历史摘要压缩未生效：需同时配置 COMPACT_MODEL / COMPACT_BASE_URL / COMPACT_API_KEY",
        "HistoryCompactor",
      );
    }
  }

  async compactIfNeeded(messages: any[]): Promise<CompactionResult> {
    const unchanged = (tokens = 0): CompactionResult => ({
      messages,
      fired: false,
      merged: false,
      originalTokens: tokens,
      compactedTokens: tokens,
    });

    if (!this.isConfigured() || !Array.isArray(messages)) return unchanged();

    let systemCount = 0;
    while (
      systemCount < messages.length &&
      messages[systemCount]?.role === "system"
    )
      systemCount++;
    const systemMsgs = messages.slice(0, systemCount);
    const rest = messages.slice(systemCount);

    const keepRecent = Math.max(1, this.config.keepRecent);
    const history = rest.slice(0, Math.max(0, rest.length - keepRecent));
    const originalTokens = countTokensForMessages(messages);
    if (history.length === 0) return unchanged(originalTokens);

    const historyTokens = countTokensForMessages(history);
    if (historyTokens < this.config.thresholdTokens)
      return unchanged(originalTokens);

    const hashes = history.map((m) => this.hash(JSON.stringify(m)));
    const cacheKey = this.hash(
      `${this.config.model}|${this.config.thresholdTokens}|${this.config.keepRecent}|${this.config.minDeltaTokens}\n${hashes[0]}`,
    );

    return this.withLock(cacheKey, async () => {
      const entry = this.findEntry(cacheKey, hashes);
      const covered = entry ? entry.hashes.length : 0;
      const delta = history.slice(covered);
      const deltaTokens = countTokensForMessages(delta);

      // 增量按 minDelta 攒批合并：不足阈值时摘要 + 未合并 delta 一起原样下发，
      // 避免每轮都打一次 summarizer（LLM 成本按 minDelta 分摊而不是按轮次）
      const needsMerge = !entry || deltaTokens >= this.config.minDeltaTokens;
      let summary = entry?.summary ?? "";
      const merged = needsMerge;
      if (needsMerge) {
        summary = await this.summarize(entry?.summary ?? null, delta);
        this.storeEntry(cacheKey, {
          hashes: [...hashes],
          summary,
          lastAccess: Date.now(),
        });
      } else if (entry) {
        entry.lastAccess = Date.now();
      }

      const summaryMessage = {
        role: "user",
        content: `[compacted summary]\n${summary}`,
      };
      const recent = rest.slice(-keepRecent);
      const tail = needsMerge ? recent : [...delta, ...recent];
      const out = [...systemMsgs, summaryMessage, ...tail];

      return {
        messages: out,
        fired: true,
        merged,
        originalTokens,
        compactedTokens: countTokensForMessages(out),
      };
    });
  }

  private isConfigured(): boolean {
    const { enabled, model, baseUrl, apiKey } = this.config;
    return enabled && Boolean(model) && Boolean(baseUrl) && Boolean(apiKey);
  }

  private async summarize(
    previous: string | null,
    delta: any[],
  ): Promise<string> {
    const transcript = delta
      .map((m) => `${m?.role ?? "unknown"}: ${this.snippet(m)}`)
      .join("\n\n");
    const userContent = previous
      ? `### Previous summary\n${previous}\n\n### New messages (merge into the summary)\n${transcript}`
      : `### Conversation transcript\n${transcript}`;

    const endpoint = buildChatCompletionsEndpoint(this.config.baseUrl);
    const response = await upstreamFetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: SUMMARY_MAX_TOKENS,
      }),
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(
        `compaction summarize HTTP ${response.status} - ${errorText.slice(0, 200)}`,
      );
    }

    const result: any = await response.json();
    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("compaction summarize returned empty summary");
    }
    return content;
  }

  private snippet(message: any): string {
    const raw =
      typeof message?.content === "string"
        ? message.content
        : JSON.stringify(message?.content ?? message);
    return raw.length > MESSAGE_SNIPPET_CHARS
      ? `${raw.slice(0, MESSAGE_SNIPPET_CHARS)}\n[...truncated]`
      : raw;
  }

  /** 找到与当前历史前缀匹配的缓存条目；顺带清理过期条目 */
  private findEntry(
    cacheKey: string,
    hashes: string[],
  ): ConversationEntry | null {
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.lastAccess > this.config.cacheTtlMs) {
      this.cache.delete(cacheKey);
      return null;
    }
    return this.isPrefixMatch(entry.hashes, hashes) ? entry : null;
  }

  private isPrefixMatch(stored: string[], current: string[]): boolean {
    if (stored.length === 0 || stored.length > current.length) return false;
    for (let i = 0; i < stored.length; i++) {
      if (stored[i] !== current[i]) return false;
    }
    return true;
  }

  private storeEntry(cacheKey: string, entry: ConversationEntry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    // 容量 <=256，按绝对 lastAccess 时间戳 O(n) 逐出，避免活跃摘要被误删
    while (this.cache.size > this.config.cacheSize) {
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;
      for (const [key, cached] of this.cache) {
        if (cached.lastAccess < oldestAccess) {
          oldestKey = key;
          oldestAccess = cached.lastAccess;
        }
      }
      if (oldestKey === null) break;
      this.cache.delete(oldestKey);
    }
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private hash(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
  }
}

export const historyCompactor = new HistoryCompactor();
