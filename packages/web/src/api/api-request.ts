import request from '@/utils/request';

export interface ApiRequest {
  id: string;
  virtual_key_id: string | null;
  /** 列表接口服务端 JOIN 出的展示名，避免前端再拉全量密钥表 */
  virtual_key_name?: string | null;
  provider_id: string | null;
  provider_name?: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens: number | null;
  status: string;
  response_time: number | null;
  tffb_ms: number | null;
  error_message: string | null;
  created_at: number;
  request_body: string | null;
  response_body: string | null;
  request_params_json?: Record<string, unknown> | string | null;
  response_meta_json?: Record<string, unknown> | string | null;
  cache_hit: number;
  request_type: string;
  compression_original_tokens: number | null;
  compression_saved_tokens: number | null;
  run_id?: string | null;
  /** 客户端显式会话标识；旧数据与未携带标识的客户端为 null */
  session_id?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  tfft_ms?: number | null;
  route_tier?: string | null;
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
  runId?: string;
  sessionId?: string;
  ip?: string;
  requestType?: string;
  /** 1 = 只看缓存命中，0 = 只看未命中；未传则不筛选 */
  cacheHit?: 0 | 1;
}

export interface ApiRequestSessionEntry {
  id: string;
  created_at: number;
  model: string | null;
  status: string;
}

export interface ApiRequestSession {
  sessionId: string | null;
  /** explicit = 按 session_id 精确匹配；heuristic = (虚拟密钥, IP) + 30min 间隔推断 */
  strategy: 'explicit' | 'heuristic';
  /** created_at 升序 */
  requests: ApiRequestSessionEntry[];
  /** 当前请求在 requests 中的下标；-1 表示会话被截断、锚点不在返回窗口内 */
  anchorIndex: number;
  truncated: boolean;
}

export const apiRequestApi = {
  getAll(params?: ApiRequestQueryParams): Promise<ApiRequestListResponse> {
    return request.get('/admin/config/api-requests', { params });
  },

  getById(id: string): Promise<ApiRequest> {
    return request.get(`/admin/config/api-requests/${id}`);
  },

  getSession(id: string): Promise<ApiRequestSession> {
    return request.get(`/admin/config/api-requests/${id}/session`);
  },

  clean(daysToKeep: number = 7): Promise<{ success: boolean; deletedCount: number; summarizedCount?: number; deletedRequestCount?: number; message: string }> {
    return request.post('/admin/config/api-requests/clean', { daysToKeep });
  },
};
