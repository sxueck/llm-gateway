import request from '@/utils/request';

export interface LiteLLMSearchResult {
  modelName: string;
  provider?: string;
  maxTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputCost?: number;
  outputCost?: number;
  supportsVision?: boolean;
  supportsFunctionCalling?: boolean;
  score: number;
}

export interface LiteLLMStats {
  totalModels: number;
  lastUpdate: number;
  cacheAge: number;
  providers: string[];
}

export interface LiteLLMModelDetail {
  modelName: string;
  rawInfo: any;
  attributes: any;
}

export const litellmPresetsApi = {
  getStats(): Promise<LiteLLMStats> {
    return request.get('/admin/litellm-presets/stats');
  },

  updatePresets(): Promise<{ success: boolean; message: string; count?: number }> {
    return request.post('/admin/litellm-presets/update');
  },

  searchModels(query: string, limit?: number): Promise<{
    query: string;
    results: LiteLLMSearchResult[];
    total: number;
  }> {
    return request.post('/admin/litellm-presets/search', { query, limit });
  },

  getModelDetail(modelName: string): Promise<LiteLLMModelDetail> {
    return request.get(`/admin/litellm-presets/model/${encodeURIComponent(modelName)}`);
  },
};

