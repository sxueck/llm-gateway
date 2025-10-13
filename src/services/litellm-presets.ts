import { memoryLogger } from './logger.js';
import type { ModelAttributes } from '../types/index.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

interface LiteLLMModelInfo {
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

interface LiteLLMData {
  [modelName: string]: LiteLLMModelInfo;
}

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_FILE_PATH = './data/litellm-presets.json';
const CACHE_DURATION = 24 * 60 * 60 * 1000;

export class LiteLLMPresetsService {
  private cachedData: LiteLLMData | null = null;
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
        memoryLogger.info(`从缓存加载 LiteLLM 预设: ${Object.keys(this.cachedData || {}).length} 个模型`, 'LiteLLM');
      }
    } catch (error: any) {
      memoryLogger.error(`加载 LiteLLM 缓存失败: ${error.message}`, 'LiteLLM');
      this.cachedData = null;
      this.lastUpdateTime = 0;
    }
  }

  private saveToCache(data: LiteLLMData): void {
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
      memoryLogger.info(`LiteLLM 预设已缓存: ${Object.keys(data).length} 个模型`, 'LiteLLM');
    } catch (error: any) {
      memoryLogger.error(`保存 LiteLLM 缓存失败: ${error.message}`, 'LiteLLM');
    }
  }

  async updateFromRemote(): Promise<{ success: boolean; message: string; count?: number }> {
    try {
      memoryLogger.info('开始从远程更新 LiteLLM 预设...', 'LiteLLM');
      
      const response = await fetch(LITELLM_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as LiteLLMData;
      
      if (!data || typeof data !== 'object') {
        throw new Error('无效的数据格式');
      }

      this.saveToCache(data);
      
      const count = Object.keys(data).length;
      memoryLogger.info(`LiteLLM 预设更新成功: ${count} 个模型`, 'LiteLLM');
      
      return {
        success: true,
        message: `成功更新 ${count} 个模型预设`,
        count,
      };
    } catch (error: any) {
      const errorMsg = `更新 LiteLLM 预设失败: ${error.message}`;
      memoryLogger.error(errorMsg, 'LiteLLM');
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
    info: LiteLLMModelInfo;
    score: number;
  }> {
    if (!this.cachedData) {
      return [];
    }

    const lowerQuery = query.toLowerCase().trim();
    if (!lowerQuery) {
      return [];
    }

    const results: Array<{ modelName: string; info: LiteLLMModelInfo; score: number }> = [];

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

  convertToModelAttributes(litellmInfo: LiteLLMModelInfo): ModelAttributes {
    const attrs: ModelAttributes = {};

    const fieldMapping: Array<keyof LiteLLMModelInfo> = [
      'max_tokens',
      'max_input_tokens',
      'max_output_tokens',
      'input_cost_per_token',
      'output_cost_per_token',
      'litellm_provider',
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
      if (litellmInfo[field] !== undefined) {
        (attrs as any)[field] = litellmInfo[field];
      }
    }

    return attrs;
  }

  getModelInfo(modelName: string): LiteLLMModelInfo | null {
    if (!this.cachedData) {
      return null;
    }
    return this.cachedData[modelName] || null;
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
        if (info.litellm_provider) {
          providers.add(info.litellm_provider);
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

export const litellmPresetsService = new LiteLLMPresetsService();

