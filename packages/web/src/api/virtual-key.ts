import request from '@/utils/request';
import type { CreateVirtualKeyRequest, UpdateVirtualKeyRequest, VirtualKey } from '@/types';

type VirtualKeyListResponse = { virtualKeys: VirtualKey[] };
type VirtualKeyCreateResponse = { virtualKey: VirtualKey; keyValue: string };
type VirtualKeyDeleteResponse = { success: boolean };
type VirtualKeyRotateResponse = { keyValue: string };

const ADMIN_VIRTUAL_KEYS_PATH = '/admin/virtual-keys';

const VIRTUAL_KEYS_QUOTAS_PATH = `${ADMIN_VIRTUAL_KEYS_PATH}/quotas`;

/** Counting window of a per-(virtual key × model) token quota. */
export type VirtualKeyQuotaPeriod = 'daily' | 'weekly';

/** Token quota of one (virtual key × model) pair for one counting period. */
export interface VirtualKeyModelQuota {
  model: string;
  /** Ceiling in millions of tokens for the period; null = no quota stored. */
  limitMillions: number | null;
  /** Tokens consumed so far in the current window: gateway-timezone calendar day,
   * or Monday-start natural week when period === 'weekly'. */
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
  /** Omitted (or 'daily') targets the daily window; 'weekly' the natural-week one. */
  period?: VirtualKeyQuotaPeriod;
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

  /** `period` is omitted from the query for the default 'daily' window, so the
   * daily request stays byte-identical to the pre-weekly wire format. */
  getQuotas(virtualKeyId: string, period: VirtualKeyQuotaPeriod = 'daily'): Promise<VirtualKeyQuotasResponse> {
    const params: { virtualKeyId: string; period?: VirtualKeyQuotaPeriod } = { virtualKeyId };
    if (period !== 'daily') params.period = period;
    return request.get(VIRTUAL_KEYS_QUOTAS_PATH, { params });
  },

  /** Bulk upsert; the response is not consumed — re-read usage via getQuotas. */
  updateQuotasBulk(data: VirtualKeyQuotaBulkRequest): Promise<unknown> {
    return request.put(`${VIRTUAL_KEYS_QUOTAS_PATH}/bulk`, data);
  },
};
