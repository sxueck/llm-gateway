import { systemConfigDb } from '../db/index.js';
import { memoryLogger } from './logger.js';

export const DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES = [
  'minimal',
  'low',
  'medium',
  'high',
  'none',
];

export const REASONING_EFFORT_SUFFIXES_CONFIG_KEY = 'reasoning_effort_model_suffixes';

class ReasoningEffortSuffixesCache {
  private suffixes: string[] = [...DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES];
  private loaded = false;

  async initialize(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const cfg = await systemConfigDb.get(REASONING_EFFORT_SUFFIXES_CONFIG_KEY);
      if (cfg) {
        this.suffixes = normalizeSuffixes(cfg.value);
      } else {
        this.suffixes = [...DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES];
      }
      this.loaded = true;
    } catch (error: any) {
      this.suffixes = [...DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES];
      memoryLogger.warn(
        `加载 reasoning_effort 后缀白名单失败，使用默认值: ${error.message}`,
        'ReasoningEffortSuffixes'
      );
    }
  }

  getSuffixes(): string[] {
    return this.suffixes;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

export const reasoningEffortSuffixesCache = new ReasoningEffortSuffixesCache();

export function normalizeSuffixes(rawValue: string | string[]): string[] {
  let arr: string[];
  if (Array.isArray(rawValue)) {
    arr = rawValue;
  } else {
    try {
      const parsed = JSON.parse(rawValue);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      arr = [];
    }
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
