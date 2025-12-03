import request from '@/utils/request';

interface CrudApi<T, C = T, U = C> {
  getAll(): Promise<T[]>;
  getById(id: string): Promise<T>;
  create(data: C): Promise<T>;
  update(id: string, data: U): Promise<T>;
  delete(id: string): Promise<{ success: boolean }>;
}

/**
 * 简单资源的通用 CRUD API 工厂
 * - 仅适用于返回结构为 list/detail 的基础 REST 接口
 */
export function createCrudApi<T, C = T, U = C>(base: string): CrudApi<T, C, U> {
  return {
    getAll(): Promise<T[]> {
      return request.get(base);
    },

    getById(id: string): Promise<T> {
      return request.get(`${base}/${id}`);
    },

    create(data: C): Promise<T> {
      return request.post(base, data);
    },

    update(id: string, data: U): Promise<T> {
      return request.put(`${base}/${id}`, data);
    },

    delete(id: string): Promise<{ success: boolean }> {
      return request.delete(`${base}/${id}`);
    },
  };
}
