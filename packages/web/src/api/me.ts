import request from '@/utils/request'
import type { VirtualKey } from '@/types'
import type {
  ApiRequest,
  ApiRequestListResponse,
  ApiRequestQueryParams,
} from '@/api/api-request'

/**
 * 普通用户自助接口（/api/me/*）。
 *
 * 响应包络按既有 admin 列表/接口的形态假设：
 *   GET /me/virtual-keys   -> { virtualKeys: VirtualKey[] }
 *   GET /me/api-requests   -> { data, total, page, pageSize, totalPages }
 *   GET /me/api-requests/:id -> ApiRequest
 * 后端最终形态若有出入，只需调整这一层。
 */

/** 自助视角支持的过滤项（比 admin 接口窄：没有 provider/ip/sessionId 等运维维度） */
export type MyApiRequestQueryParams = Pick<
  ApiRequestQueryParams,
  'page' | 'pageSize' | 'startTime' | 'endTime' | 'status' | 'virtualKeyId' | 'model'
>

type MyVirtualKeyListResponse = { virtualKeys: VirtualKey[] }

export const meApi = {
  getVirtualKeys(): Promise<MyVirtualKeyListResponse> {
    return request.get('/me/virtual-keys')
  },

  getApiRequests(params?: MyApiRequestQueryParams): Promise<ApiRequestListResponse> {
    return request.get('/me/api-requests', { params })
  },

  getApiRequestById(id: string): Promise<ApiRequest> {
    return request.get(`/me/api-requests/${id}`)
  },
}
