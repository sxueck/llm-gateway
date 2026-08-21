import request from "@/utils/request";
import type {
  ModelAttributes,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
} from "@/types";

export interface ModelInfo {
  id: string;
  name: string;
  created?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_length?: number;
  context_window?: number;
  limit?: number;
  [key: string]: unknown;
}

const CAPABILITY_NUMBER_FIELDS = [
  "max_tokens",
  "max_completion_tokens",
  "max_input_tokens",
  "max_output_tokens",
  "context_length",
  "context_window",
  "limit",
] as const;

// Extract capability metadata from an upstream /v1/models entry into modelAttributes
// so it survives into GET /v1/models; returns undefined when the entry carries none.
export function extractModelAttributes(
  model: ModelInfo,
): ModelAttributes | undefined {
  const attributes: ModelAttributes = {};
  for (const field of CAPABILITY_NUMBER_FIELDS) {
    const value = model[field];
    if (typeof value === "number") {
      attributes[field] = value;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

export const providerApi = {
  getAll(): Promise<{ providers: Provider[] }> {
    return request.get("/admin/providers");
  },

  getById(id: string, includeApiKey = false): Promise<Provider> {
    return request.get(`/admin/providers/${id}`, {
      params: { includeApiKey: includeApiKey.toString() },
    });
  },

  create(data: CreateProviderRequest): Promise<Provider> {
    return request.post("/admin/providers", data);
  },

  update(id: string, data: UpdateProviderRequest): Promise<Provider> {
    return request.put(`/admin/providers/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/providers/${id}`);
  },

  test(
    id: string,
  ): Promise<{
    success: boolean;
    status?: number;
    message: string;
    latencyMs?: number;
  }> {
    return request.post(`/admin/providers/${id}/test`);
  },

  fetchModels(
    baseUrl: string,
    apiKey: string,
  ): Promise<{ success: boolean; message: string; models: ModelInfo[] }> {
    return request.post("/admin/providers/fetch-models", { baseUrl, apiKey });
  },

  batchImport(
    providers: Array<{
      id: string;
      name: string;
      baseUrl: string;
      apiKey: string;
      enabled?: boolean;
    }>,
    skipExisting = true,
  ): Promise<{
    success: boolean;
    message: string;
    results: {
      success: number;
      failed: number;
      skipped: number;
      errors: Array<{ id: string; error: string }>;
    };
  }> {
    return request.post("/admin/providers/batch-import", {
      providers,
      skipExisting,
    });
  },
};
