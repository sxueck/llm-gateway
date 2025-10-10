import request from '@/utils/request';
import type { Provider, CreateProviderRequest, UpdateProviderRequest } from '@/types';

export interface ModelInfo {
  id: string;
  name: string;
  created?: number;
}

export const providerApi = {
  getAll(): Promise<{ providers: Provider[] }> {
    return request.get('/admin/providers');
  },

  getById(id: string, includeApiKey = false): Promise<Provider> {
    return request.get(`/admin/providers/${id}`, { params: { includeApiKey: includeApiKey.toString() } });
  },

  create(data: CreateProviderRequest): Promise<Provider> {
    return request.post('/admin/providers', data);
  },

  update(id: string, data: UpdateProviderRequest): Promise<Provider> {
    return request.put(`/admin/providers/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/providers/${id}`);
  },

  test(id: string): Promise<{ success: boolean; status?: number; message: string }> {
    return request.post(`/admin/providers/${id}/test`);
  },

  fetchModels(baseUrl: string, apiKey: string): Promise<{ success: boolean; message: string; models: ModelInfo[] }> {
    return request.post('/admin/providers/fetch-models', { baseUrl, apiKey });
  },

  batchImport(providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string; enabled?: boolean }>, skipExisting = true): Promise<{
    success: boolean;
    message: string;
    results: {
      success: number;
      failed: number;
      skipped: number;
      errors: Array<{ id: string; error: string }>;
    };
  }> {
    return request.post('/admin/providers/batch-import', { providers, skipExisting });
  },
};

