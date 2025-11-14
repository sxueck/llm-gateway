import request from '@/utils/request';
import type { Model, CreateModelRequest, UpdateModelRequest } from '@/types';

export const modelApi = {
  getAll(): Promise<{ models: Model[] }> {
    return request.get('/admin/models');
  },

  getById(id: string): Promise<Model> {
    return request.get(`/admin/models/${id}`);
  },

  getByProviderId(providerId: string): Promise<{ models: Model[] }> {
    return request.get(`/admin/models/by-provider/${providerId}`);
  },

  create(data: CreateModelRequest): Promise<Model> {
    return request.post('/admin/models', data);
  },

  batchCreate(models: CreateModelRequest[]): Promise<{ models: Model[]; success: boolean }> {
    return Promise.all(
      models.map(model => this.create(model))
    ).then(results => ({
      models: results,
      success: true,
    }));
  },

  update(id: string, data: UpdateModelRequest): Promise<Model> {
    return request.put(`/admin/models/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/models/${id}`);
  },

  test(id: string): Promise<{
    success: boolean;
    message: string;
    chat: {
      success: boolean;
      status?: number;
      message: string;
      responseTime: number;
      response?: {
        content: string;
        usage?: any;
      };
      error?: string;
    };
    responses: {
      success: boolean;
      status?: number;
      message: string;
      responseTime: number;
      response?: {
        content: string;
        usage?: any;
      };
      error?: string;
    };
  }> {
    return request.post(`/admin/models/${id}/test`);
  },
};

