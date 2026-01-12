import request from '@/utils/request';
import type { CreateVirtualKeyRequest, UpdateVirtualKeyRequest, VirtualKey } from '@/types';

type VirtualKeyListResponse = { virtualKeys: VirtualKey[] };
type VirtualKeyCreateResponse = { virtualKey: VirtualKey; keyValue: string };
type VirtualKeyDeleteResponse = { success: boolean };
type VirtualKeyValidateResponse = { valid: boolean; message?: string };

const ADMIN_VIRTUAL_KEYS_PATH = '/admin/virtual-keys';
const ADMIN_VIRTUAL_KEYS_VALIDATE_PATH = `${ADMIN_VIRTUAL_KEYS_PATH}/validate`;

const virtualKeyPath = (id: string) => `${ADMIN_VIRTUAL_KEYS_PATH}/${id}`;

export const virtualKeyApi = {
  getAll(): Promise<VirtualKeyListResponse> {
    return request.get(ADMIN_VIRTUAL_KEYS_PATH);
  },

  getById(id: string): Promise<VirtualKey> {
    return request.get(virtualKeyPath(id));
  },

  create(data: CreateVirtualKeyRequest): Promise<VirtualKeyCreateResponse> {
    return request.post(ADMIN_VIRTUAL_KEYS_PATH, data);
  },

  update(id: string, data: UpdateVirtualKeyRequest): Promise<VirtualKey> {
    return request.put(virtualKeyPath(id), data);
  },

  delete(id: string): Promise<VirtualKeyDeleteResponse> {
    return request.delete(virtualKeyPath(id));
  },

  validate(customKey: string): Promise<VirtualKeyValidateResponse> {
    return request.post(ADMIN_VIRTUAL_KEYS_VALIDATE_PATH, { customKey });
  },
};
