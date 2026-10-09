import { memoryLogger } from './logger.js';
import type { ModelAttributes } from '../types/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { upstreamFetch } from '../utils/upstream-fetch.js';
import {
  createPresetResolver,
  presetEntryScore,
  type PricingMatch,
} from './pricing-normalize.js';

export interface ModelPresetInfo {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_character?: number;
  output_cost_per_character?: number;
  input_cost_per_token_above_128k_tokens?: number;
  output_cost_per_token_above_128k_tokens?: number;
  input_cost_per_image?: number;
  output_cost_per_image?: number;
  input_cost_per_audio_per_second?: number;
  output_cost_per_audio_per_second?: number;
  input_cost_per_video_per_second?: number;
  /** Cost per token for cache read operations (prompt caching) */
  cache_read_cost_per_token?: number;
  /** Cost per token for cache write operations (prompt caching) */
  cache_write_cost_per_token?: number;
  litellm_provider?: string;
  provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_assistant_prefill?: boolean;
  supports_prompt_caching?: boolean;
  supports_response_schema?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  tool_use_system_prompt_supported?: boolean;
}

interface ModelPresetData {
  [modelName: string]: ModelPresetInfo;
}

const MODEL_PRESET_URL = 'https://models.dev/api.json';
const CACHE_FILE_PATH = './data/model-presets.json';
const CACHE_DURATION = 24 * 60 * 60 * 1000;

function toPerTokenFromPer1M(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value / 1_000_000;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function shouldReplaceExisting(
  modelId: string,
  existing: ModelPresetInfo,
  incoming: ModelPresetInfo,
): boolean {
  // 同一个 modelId 会被多家供应商重复登记：自研实验室牌价优先，云托管/聚合商只兑底。
  const existingScore = presetEntryScore(modelId, {
    ...existing,
    provider: existing.litellm_provider || existing.provider,
  });
  const incomingScore = presetEntryScore(modelId, {
    ...incoming,
    provider: incoming.litellm_provider || incoming.provider,
  });
  if (existingScore !== incomingScore) return incomingScore > existingScore;

  // Prefer entries that contain token pricing.
  const existingHasCost =
    typeof existing.input_cost_per_token === 'number' || typeof existing.output_cost_per_token === 'number';
  const incomingHasCost =
    typeof incoming.input_cost_per_token === 'number' || typeof incoming.output_cost_per_token === 'number';
  if (existingHasCost !== incomingHasCost) return incomingHasCost;

  // Prefer entries that contain token limits.
  const existingHasLimits =
    typeof existing.max_tokens === 'number' ||
    typeof existing.max_input_tokens === 'number' ||
    typeof existing.max_output_tokens === 'number';
  const incomingHasLimits =
    typeof incoming.max_tokens === 'number' ||
    typeof incoming.max_input_tokens === 'number' ||
    typeof incoming.max_output_tokens === 'number';
  if (existingHasLimits !== incomingHasLimits) return incomingHasLimits;

  return false;
}

/** models.dev 是外部数据源，这里只做结构化取值，不做形状假设。 */
type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

const asStringList = (value: unknown): string[] => (Array.isArray(value) ? (value.filter(item => typeof item === 'string') as string[]) : []);

function parseModelsDevApiJson(apiJson: unknown): ModelPresetData {
  const providers = asRecord(apiJson);
  if (!providers) {
    throw new Error('无效的 models.dev 数据格式');
  }

  const data: ModelPresetData = {};

  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = asRecord(providerValue);
    if (!provider) continue;

    const providerName = asString(provider.name);
    const models = asRecord(provider.models);
    if (!models) continue;

    for (const [modelKey, modelValue] of Object.entries(models)) {
      const model = asRecord(modelValue);
      if (!model) continue;

      const modelId = (asString(model.id) || modelKey).trim();
      if (!modelId) continue;

      const cost = asRecord(model.cost) || {};
      const limit = asRecord(model.limit) || {};
      const modalities = asRecord(model.modalities) || {};
      const inputModalities = asStringList(modalities.input);
      const outputModalities = asStringList(modalities.output);

      const supportsVision =
        inputModalities.includes('image') || outputModalities.includes('image') || undefined;
      const supportsAudioInput = inputModalities.includes('audio') || undefined;
      const supportsAudioOutput = outputModalities.includes('audio') || undefined;
      const supportsPdfInput = inputModalities.includes('pdf') || undefined;

      const supportsPromptCaching =
        typeof cost.cache_read === 'number' || typeof cost.cache_write === 'number' || undefined;

      const preset: ModelPresetInfo = {
        litellm_provider: providerId || providerName || undefined,
        provider: providerId || providerName || undefined,
        mode: asString(model.family),

        max_tokens: toNumber(limit.context),
        max_input_tokens: toNumber(limit.input),
        max_output_tokens: toNumber(limit.output),

        input_cost_per_token: toPerTokenFromPer1M(cost.input),
        output_cost_per_token: toPerTokenFromPer1M(cost.output),
        cache_read_cost_per_token: toPerTokenFromPer1M(cost.cache_read),
        cache_write_cost_per_token: toPerTokenFromPer1M(cost.cache_write),

        supports_function_calling: asBoolean(model.tool_call),
        supports_response_schema: asBoolean(model.structured_output),
        supports_vision: supportsVision,
        supports_audio_input: supportsAudioInput,
        supports_audio_output: supportsAudioOutput,
        supports_pdf_input: supportsPdfInput,
        supports_prompt_caching: supportsPromptCaching,
      };

      const existing = data[modelId];
      if (!existing || shouldReplaceExisting(modelId, existing, preset)) {
        data[modelId] = preset;
      }
    }
  }

  if (Object.keys(data).length === 0) {
    throw new Error('解析 models.dev 数据失败：未提取到任何模型');
  }
  return data;
}

export class ModelPresetsService {
  private cachedData: ModelPresetData | null = null;
  private lastUpdateTime: number = 0;
  /** 定价解析索引惰建；数据刷新时置空重建。 */
  private presetResolver: ((name: string) => PricingMatch<ModelPresetInfo> | null) | null = null;

  constructor() {
    this.loadFromCache();
  }

  private loadFromCache(): void {
    try {
      if (existsSync(CACHE_FILE_PATH)) {
        const content = readFileSync(CACHE_FILE_PATH, 'utf-8');
        const data = JSON.parse(content);
        this.cachedData = data.models || null;
        this.lastUpdateTime = data.lastUpdate || 0;
        this.presetResolver = null;
        memoryLogger.info(`从缓存加载模型预设: ${Object.keys(this.cachedData || {}).length} 个模型`, 'ModelPresets');
      }
    } catch (error: any) {
      memoryLogger.error(`加载模型预设缓存失败: ${error.message}`, 'ModelPresets');
      this.cachedData = null;
      this.lastUpdateTime = 0;
    }
  }

  private saveToCache(data: ModelPresetData): void {
    try {
      const dir = dirname(CACHE_FILE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const cacheData = {
        models: data,
        lastUpdate: Date.now(),
      };

      writeFileSync(CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2), 'utf-8');
      this.cachedData = data;
      this.lastUpdateTime = Date.now();
      this.presetResolver = null;
      memoryLogger.info(`模型预设已缓存: ${Object.keys(data).length} 个模型`, 'ModelPresets');
    } catch (error: any) {
      memoryLogger.error(`保存模型预设缓存失败: ${error.message}`, 'ModelPresets');
    }
  }

  async updateFromRemote(): Promise<{ success: boolean; message: string; count?: number }> {
    try {
      memoryLogger.info('开始从远程更新模型预设...', 'ModelPresets');
      
      const response = await upstreamFetch(MODEL_PRESET_URL, {
        headers: {
          accept: 'application/json',
          'user-agent': 'llm-gateway/0.2 (model-presets)'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const apiJson = await response.json();
      const data = parseModelsDevApiJson(apiJson);

      this.saveToCache(data);
      
      const count = Object.keys(data).length;
      memoryLogger.info(`模型预设更新成功: ${count} 个模型`, 'ModelPresets');
      
      return {
        success: true,
        message: `成功更新 ${count} 个模型预设`,
        count,
      };
    } catch (error: any) {
      const errorMsg = `更新模型预设失败: ${error.message}`;
      memoryLogger.error(errorMsg, 'ModelPresets');
      return {
        success: false,
        message: errorMsg,
      };
    }
  }

  async ensureDataAvailable(): Promise<void> {
    if (!this.cachedData) {
      await this.updateFromRemote();
    }
  }

  shouldAutoUpdate(): boolean {
    if (!this.cachedData) return true;
    const elapsed = Date.now() - this.lastUpdateTime;
    return elapsed > CACHE_DURATION;
  }

  searchModels(query: string, limit: number = 20): Array<{
    modelName: string;
    info: ModelPresetInfo;
    score: number;
  }> {
    if (!this.cachedData) {
      return [];
    }

    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) {
      return [];
    }

    const results: Array<{ modelName: string; info: ModelPresetInfo; score: number }> = [];

    for (const [modelName, info] of Object.entries(this.cachedData)) {
      const lowerModelName = modelName.toLowerCase();

      let score = 0;

      if (lowerModelName === lowerQuery) {
        score = 1000;
      } else if (lowerModelName.startsWith(lowerQuery)) {
        score = 500;
      } else if (lowerModelName.includes(lowerQuery)) {
        score = 100;
      }

      if (score > 0) {
        results.push({ modelName, info, score });
      }
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  convertToModelAttributes(modelInfo: ModelPresetInfo): ModelAttributes {
    const attrs: ModelAttributes = {};

    const fieldMapping: Array<keyof ModelPresetInfo> = [
      'max_tokens',
      'max_input_tokens',
      'max_output_tokens',
      'input_cost_per_token',
      'output_cost_per_token',
      'cache_read_cost_per_token',
      'cache_write_cost_per_token',
      'provider',
      'mode',
      'supports_function_calling',
      'supports_vision',
      'supports_assistant_prefill',
      'supports_prompt_caching',
      'supports_audio_input',
      'supports_audio_output',
      'supports_pdf_input',
    ];

    for (const field of fieldMapping) {
      if (modelInfo[field] !== undefined) {
        (attrs as any)[field] = modelInfo[field];
      }
    }

    return attrs;
  }

  getModelInfo(modelName: string): ModelPresetInfo | null {
    if (!this.cachedData) {
      return null;
    }
    return this.cachedData[modelName] || null;
  }

  /**
   * 按“官方实验室牌价”解析模型名：原名 → 去装饰后缀 → 同家族最近邻。
   *
   * 与 getModelInfo 的区别只在千容：虚拟名、带 `[1m]`/快照日期/供应商前缀的名字
   * 不再因精确匹配落空而被记成 0 成本。策略为 family 的是近似价（不同型号）。
   */
  resolvePreset(modelName: string): PricingMatch<ModelPresetInfo> | null {
    if (!this.cachedData) {
      return null;
    }
    if (!this.presetResolver) {
      this.presetResolver = createPresetResolver(this.cachedData);
    }
    return this.presetResolver(modelName);
  }

  getAllModels(): Array<{ modelName: string; info: ModelPresetInfo }> {
    if (!this.cachedData) {
      return [];
    }
    return Object.entries(this.cachedData).map(([modelName, info]) => ({
      modelName,
      info,
    }));
  }

  getStats(): {
    totalModels: number;
    lastUpdate: number;
    cacheAge: number;
    providers: string[];
  } {
    const totalModels = this.cachedData ? Object.keys(this.cachedData).length : 0;
    const cacheAge = this.lastUpdateTime ? Date.now() - this.lastUpdateTime : 0;
    
    const providers = new Set<string>();
    if (this.cachedData) {
      for (const info of Object.values(this.cachedData)) {
        if (info.provider) {
          providers.add(info.provider);
        }
      }
    }

    return {
      totalModels,
      lastUpdate: this.lastUpdateTime,
      cacheAge,
      providers: Array.from(providers).sort((a, b) => a.localeCompare(b)),
    };
  }
}

export const modelPresetsService = new ModelPresetsService();
