import request from '@/utils/request';
import type { User, UserRole, VirtualKey } from '@/types';

/**
 * 管理员用户与虚拟密钥绑定管理。
 * 角色接口走 /admin/users，绑定接口走 /admin/user-access。
 */
export const userAccessApi = {
  /** 安全用户列表（不含口令哈希等敏感字段）。 */
  getAllUsers(): Promise<User[]> {
    return request.get('/auth/users');
  },

  /** 升级 / 降级用户角色。 */
  updateUserRole(userId: string, role: UserRole): Promise<unknown> {
    return request.patch(`/admin/users/${userId}/role`, { role });
  },

  /** 某用户当前绑定的虚拟密钥。 */
  getUserBindings(userId: string): Promise<{ virtualKeys: VirtualKey[] }> {
    return request.get(`/admin/user-access/users/${userId}/bindings`);
  },

  getVirtualKeyBindings(virtualKeyId: string): Promise<{ virtualKeyId: string; users: Array<{ userId: string; username: string; boundAt: number }> }> {
    return request.get(`/admin/user-access/virtual-keys/${encodeURIComponent(virtualKeyId)}/bindings`);
  },

  bindUserKeys(userId: string, virtualKeyIds: string[]): Promise<unknown> {
    return request.post('/admin/user-access/bindings', { userId, virtualKeyIds });
  },

  /** 解绑单个虚拟密钥。 */
  removeBinding(userId: string, virtualKeyId: string): Promise<unknown> {
    return request.delete(`/admin/user-access/users/${userId}/bindings/${virtualKeyId}`);
  },
};
