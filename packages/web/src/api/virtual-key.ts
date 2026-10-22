import request from '@/utils/request';
import type { CreateVirtualKeyRequest, UpdateVirtualKeyRequest, VirtualKey } from '@/types';

type VirtualKeyListResponse = { virtualKeys: VirtualKey[] };
type VirtualKeyCreateResponse = { virtualKey: VirtualKey; keyValue: string };
type VirtualKeyDeleteResponse = { success: boolean };
type VirtualKeyRotateResponse = { keyValue: string };

const ADMIN_VIRTUAL_KEYS_PATH = '/admin/virtual-keys';

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
};
