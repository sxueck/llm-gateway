import request from '../utils/request';

export interface CostMapping {
  id: string;
  pattern: string;
  target_model: string;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface CreateCostMappingParams {
  pattern: string;
  target_model: string;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateCostMappingParams {
  pattern?: string;
  target_model?: string;
  priority?: number;
  enabled?: boolean;
}

export interface CostResolution {
  source: 'direct' | 'mapping';
  model?: string;
  mapping_pattern?: string;
  target_model?: string;
  info: any; // ModelPresetInfo
}

export const costMappingApi = {
  getAll: () => {
    return request.get<CostMapping[]>('/admin/cost-mappings');
  },

  create: (data: CreateCostMappingParams) => {
    return request.post<CostMapping>('/admin/cost-mappings', data);
  },

  update: (id: string, data: UpdateCostMappingParams) => {
    return request.put<CostMapping>(`/admin/cost-mappings/${id}`, data);
  },

  delete: (id: string) => {
    return request.delete<{ success: boolean }>(`/admin/cost-mappings/${id}`);
  },

  resolve: (model: string) => {
    return request.post<CostResolution>('/admin/cost-mappings/resolve', { model });
  },
};