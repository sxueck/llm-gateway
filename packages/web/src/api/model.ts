import request from '@/utils/request';
import type { CreateModelRequest, Model, UpdateModelRequest } from '@/types';
import { createCrudApi } from './_crud-factory';

type ModelListResponse = { models: Model[] };
type DeleteResponse = { success: boolean };
type BatchCreateResponse = { models: Model[]; success: boolean };

type ModelTestSubResult = {
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

type ModelTestResponse = {
  chat: ModelTestSubResult;
  responses: ModelTestSubResult;
};

const ADMIN_MODELS_PATH = '/admin/models';
const adminModelPath = (id: string) => `${ADMIN_MODELS_PATH}/${id}`;

const baseModelApi = createCrudApi<Model, CreateModelRequest, UpdateModelRequest>(ADMIN_MODELS_PATH);

export const modelApi = {
  getAll(): Promise<ModelListResponse> {
    return request.get(ADMIN_MODELS_PATH);
  },

  getById(id: string): Promise<Model> {
    return baseModelApi.getById(id);
  },

  getByProviderId(providerId: string): Promise<ModelListResponse> {
    return request.get(`${ADMIN_MODELS_PATH}/by-provider/${providerId}`);
  },

  create(data: CreateModelRequest): Promise<Model> {
    return baseModelApi.create(data);
  },

  async batchCreate(models: CreateModelRequest[]): Promise<BatchCreateResponse> {
    const results = await Promise.all(models.map((model) => baseModelApi.create(model)));

    return {
      models: results,
      success: true,
    };
  },

  update(id: string, data: UpdateModelRequest): Promise<Model> {
    return baseModelApi.update(id, data);
  },

  delete(id: string): Promise<DeleteResponse> {
    return baseModelApi.delete(id);
  },

  test(id: string): Promise<ModelTestResponse> {
    return request.post(`${adminModelPath(id)}/test`);
  },
};
