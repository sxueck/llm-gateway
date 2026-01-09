import request from '@/utils/request';
import type { VirtualKey, CreateVirtualKeyRequest, UpdateVirtualKeyRequest } from '@/types';

export const virtualKeyApi = {
  getAll(): Promise<{ virtualKeys: VirtualKey[] }> {
    return request.get('/admin/virtual-keys');
  },

  getById(id: string): Promise<VirtualKey> {
    return request.get(`/admin/virtual-keys/${id}`);
  },

  create(data: CreateVirtualKeyRequest): Promise<{ virtualKey: VirtualKey; keyValue: string }> {
    return request.post('/admin/virtual-keys', data);
  },

  update(id: string, data: UpdateVirtualKeyRequest): Promise<VirtualKey> {
    return request.put(`/admin/virtual-keys/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/virtual-keys/${id}`);
  },

  validate(customKey: string): Promise<{ valid: boolean; message?: string }> {
    return request.post('/admin/virtual-keys/validate', { customKey });
  },
};

