import request from '@/utils/request';
import type { CreateVirtualKeyRequest, UpdateVirtualKeyRequest, VirtualKey } from '@/types';

type VirtualKeyListResponse = { virtualKeys: VirtualKey[] };
type VirtualKeyCreateResponse = { virtualKey: VirtualKey; keyValue: string };
type VirtualKeyDeleteResponse = { success: boolean };
type VirtualKeyRotateResponse = { keyValue: string };

const ADMIN_VIRTUAL_KEYS_PATH = '/admin/virtual-keys';

const VIRTUAL_KEYS_QUOTAS_PATH = `${ADMIN_VIRTUAL_KEYS_PATH}/quotas`;

/** Daily token quota of one (virtual key × model) pair. */
export interface VirtualKeyModelQuota {
  model: string;
  /** Daily ceiling in millions of tokens; null = no quota stored. */
  limitMillions: number | null;
  /** Tokens consumed so far this gateway-timezone calendar day. */
  usedTokens: number;
  requestCount: number;
}

/** One model entry of a bulk upsert: a number writes the limit, null deletes it. */
export interface VirtualKeyQuotaUpsert {
  model: string;
  limitMillions: number | null;
}

export interface VirtualKeyQuotaBulkRequest {
  virtualKeyIds: string[];
  /** Only the listed models are touched; models absent here keep their quota. */
  quotas: VirtualKeyQuotaUpsert[];
}

type VirtualKeyQuotasResponse = { quotas: VirtualKeyModelQuota[] };

const virtualKeyPath = (id: string) => `${ADMIN_VIRTUAL_KEYS_PATH}/${id}`;

export const virtualKeyApi = {
  getAll(): Promise<VirtualKeyListResponse> {
    return request.get(ADMIN_VIRTUAL_KEYS_PATH);
  },

  create(data: CreateVirtualKeyRequest): Promise<VirtualKeyCreateResponse> {
    return request.post(ADMIN_VIRTUAL_KEYS_PATH, data);
  },

  update(id: string, data: UpdateVirtualKeyRequest): Promise<VirtualKey> {
    return request.put(virtualKeyPath(id), data);
  },

  rotate(
    id: string,
    data: { keyType: 'auto' | 'custom'; customKey?: string }
  ): Promise<VirtualKeyRotateResponse> {
    return request.post(`${virtualKeyPath(id)}/rotate`, data);
  },

  delete(id: string): Promise<VirtualKeyDeleteResponse> {
    return request.delete(virtualKeyPath(id));
  },

  getQuotas(virtualKeyId: string): Promise<VirtualKeyQuotasResponse> {
    return request.get(VIRTUAL_KEYS_QUOTAS_PATH, { params: { virtualKeyId } });
  },

  /** Bulk upsert; the response is not consumed — re-read usage via getQuotas. */
  updateQuotasBulk(data: VirtualKeyQuotaBulkRequest): Promise<unknown> {
    return request.put(`${VIRTUAL_KEYS_QUOTAS_PATH}/bulk`, data);
  },
};
