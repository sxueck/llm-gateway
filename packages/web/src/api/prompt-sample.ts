import request from '@/utils/request';

export interface PromptSample {
  id: string;
  virtual_key_id: string;
  model: string;
  protocol: string;
  intent_text: string;
  prompt_tokens: number;
  intent_truncated: number;
  created_at: number;
}

export interface PromptSampleQuery {
  virtualKeyId?: string;
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}

export interface PromptSampleListResponse {
  data: PromptSample[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const promptSampleApi = {
  getAll(params?: PromptSampleQuery): Promise<PromptSampleListResponse> {
    return request.get('/admin/prompt-samples', { params });
  },

  exportCsv(params?: PromptSampleQuery): Promise<Blob> {
    return request.get('/admin/prompt-samples/export', { params: { ...params, format: 'csv' }, responseType: 'blob' });
  },

  exportJson(params?: PromptSampleQuery): Promise<Blob> {
    return request.get('/admin/prompt-samples/export', { params: { ...params, format: 'json' }, responseType: 'blob' });
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/prompt-samples/${id}`);
  },

  clean(daysToKeep: number = 30): Promise<{ success: boolean; deletedCount: number; message: string }> {
    return request.delete('/admin/prompt-samples/clean', { params: { daysToKeep } });
  },
};
