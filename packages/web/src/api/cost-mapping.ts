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

/**
 * 取价来源：direct=预设表原名精确命中；official=归一后命中官方实验室牌价；
 * mapping=人工通配规则；approx=同家族版本最近邻（参考价）；unknown=无价。
 */
export type PricingSource = 'direct' | 'official' | 'mapping' | 'approx' | 'unknown';

export interface CostResolution {
  source: PricingSource;
  model?: string;
  mapping_pattern?: string;
  target_model?: string;
  /** 真正取到牌价的预设键（归一命中时与原模型名不同） */
  pricing_model?: string;
  /** 牌价所属供应商 */
  pricing_provider?: string;
  info: any; // ModelPresetInfo
}

export interface ModelPrice {
  model: string;
  provider?: string;
  source?: PricingSource;
  pricing_model?: string;
  pricing_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  mode?: string;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
}

export const costMappingApi = {
  getAll: () => {
    return request.get<CostMapping[]>('/admin/cost-mappings');
  },

  getPrices: () => {
    return request.get<ModelPrice[]>('/admin/cost-mappings/prices');
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