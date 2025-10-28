import request from '@/utils/request';

export interface ApiRequest {
  id: string;
  virtual_key_id: string | null;
  provider_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  status: string;
  response_time: number | null;
  error_message: string | null;
  created_at: number;
  request_body: string | null;
  response_body: string | null;
  cache_hit: number;
  request_type: string;
  prompt_cache_hit_tokens: number;
  prompt_cache_write_tokens: number;
}

export interface ApiRequestListResponse {
  data: ApiRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiRequestQueryParams {
  page?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
  status?: string;
  virtualKeyId?: string;
  providerId?: string;
  model?: string;
}

export const apiRequestApi = {
  getAll(params?: ApiRequestQueryParams): Promise<ApiRequestListResponse> {
    return request.get('/admin/config/api-requests', { params });
  },

  getById(id: string): Promise<ApiRequest> {
    return request.get(`/admin/config/api-requests/${id}`);
  },

  clean(daysToKeep: number = 30): Promise<{ success: boolean; deletedCount: number; message: string }> {
    return request.post('/admin/config/api-requests/clean', { daysToKeep });
  },
};

