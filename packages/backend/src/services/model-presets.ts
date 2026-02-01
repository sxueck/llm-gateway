import { memoryLogger } from './logger.js';
import type { ModelAttributes } from '../types/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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

function providerPriority(providerId: string | undefined): number {
  const id = (providerId || '').toLowerCase();
  const table: Record<string, number> = {
    openai: 1000,
    anthropic: 950,
    google: 900,
    'google-ai-studio': 890,
    'vertex-ai': 880,
    mistral: 850,
    cohere: 800,
    xai: 780,
    deepseek: 760,
    alibaba: 720,
    qwen: 710,
    'amazon-bedrock': 700,
    bedrock: 700,
    azure: 690,
    groq: 650,
    together: 620,
    fireworks: 610,
    huggingface: 550,
    hf: 550,
    openrouter: 500,
  };
  return table[id] ?? 0;
}

function shouldReplaceExisting(existing: ModelPresetInfo, incoming: ModelPresetInfo): boolean {
  const existingP = providerPriority(existing.litellm_provider || existing.provider);
  const incomingP = providerPriority(incoming.litellm_provider || incoming.provider);
  if (incomingP !== existingP) return incomingP > existingP;

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

function parseModelsDevApiJson(apiJson: unknown): ModelPresetData {
  if (!apiJson || typeof apiJson !== 'object' || Array.isArray(apiJson)) {
    throw new Error('无效的 models.dev 数据格式');
  }

  const providers = apiJson as Record<string, any>;
  const data: ModelPresetData = {};

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue;

    const providerName = typeof provider.name === 'string' ? provider.name : undefined;
    const models = provider.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;

    for (const [modelKey, model] of Object.entries(models as Record<string, any>)) {
      if (!model || typeof model !== 'object') continue;

      const modelId = typeof model.id === 'string' && model.id ? model.id : modelKey;
      if (typeof modelId !== 'string' || !modelId.trim()) continue;

      const cost = model.cost || {};
      const limit = model.limit || {};
      const modalities = model.modalities || {};
      const inputModalities = Array.isArray(modalities.input) ? modalities.input : [];
      const outputModalities = Array.isArray(modalities.output) ? modalities.output : [];

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
        mode: typeof model.family === 'string' ? model.family : undefined,

        max_tokens: toNumber(limit.context),
        max_input_tokens: toNumber(limit.input),
        max_output_tokens: toNumber(limit.output),

        input_cost_per_token: toPerTokenFromPer1M(cost.input),
        output_cost_per_token: toPerTokenFromPer1M(cost.output),

        supports_function_calling: typeof model.tool_call === 'boolean' ? model.tool_call : undefined,
        supports_response_schema:
          typeof model.structured_output === 'boolean' ? model.structured_output : undefined,
        supports_vision: supportsVision,
        supports_audio_input: supportsAudioInput,
        supports_audio_output: supportsAudioOutput,
        supports_pdf_input: supportsPdfInput,
        supports_prompt_caching: supportsPromptCaching,
      };

      const existing = data[modelId];
      if (!existing || shouldReplaceExisting(existing, preset)) {
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
      memoryLogger.info(`模型预设已缓存: ${Object.keys(data).length} 个模型`, 'ModelPresets');
    } catch (error: any) {
      memoryLogger.error(`保存模型预设缓存失败: ${error.message}`, 'ModelPresets');
    }
  }

  async updateFromRemote(): Promise<{ success: boolean; message: string; count?: number }> {
    try {
      memoryLogger.info('开始从远程更新模型预设...', 'ModelPresets');
      
      const response = await fetch(MODEL_PRESET_URL, {
        headers: {
          accept: 'application/json',
          'user-agent': 'llm-gateway/0.2 (model-presets)'
        }
      } as any);
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
