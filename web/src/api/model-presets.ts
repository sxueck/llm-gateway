import request from '@/utils/request';

export interface ModelPresetSearchResult {
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

export interface ModelPresetStats {
  totalModels: number;
  lastUpdate: number;
  cacheAge: number;
  providers: string[];
}

export interface ModelPresetDetail {
  modelName: string;
  rawInfo: any;
  attributes: any;
}

export const modelPresetsApi = {
  getStats(): Promise<ModelPresetStats> {
    return request.get('/admin/model-presets/stats');
  },

  updatePresets(): Promise<{ success: boolean; message: string; count?: number }> {
    return request.post('/admin/model-presets/update');
  },

  searchModels(query: string, limit?: number): Promise<{
    query: string;
    results: ModelPresetSearchResult[];
    total: number;
  }> {
    return request.post('/admin/model-presets/search', { query, limit });
  },

  getModelDetail(modelName: string): Promise<ModelPresetDetail> {
    return request.get(`/admin/model-presets/model/${encodeURIComponent(modelName)}`);
  },
};

