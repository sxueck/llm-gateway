import request from "@/utils/request";

export interface WorkerPluginVersion {
  id: string;
  version: string;
  digest: string;
  name: string;
  description: string | null;
  status: "draft" | "published" | "deprecated" | "revoked";
  changelog: string | null;
  model_profile: string;
  allow_client_override: boolean;
  tools: string[];
  max_turns: number;
  timeout_seconds: number;
  published_at: number | null;
  deprecated_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface PluginEnrollment {
  plugin_id: string;
  version: string;
  enabled: boolean;
  is_default: boolean;
  updated_at: number;
}

export interface WorkerPluginListResponse {
  plugins: WorkerPluginVersion[];
  enrollments: PluginEnrollment[];
}

export interface PublishPluginResponse {
  id: string;
  version: string;
  digest: string;
  status: string;
  published_at: number | null;
}

export interface PublishPluginPayload {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  changelog?: string;
}

export const workerPluginApi = {
  list(): Promise<WorkerPluginListResponse> {
    return request.get("/admin/worker-plugins");
  },

  publish(payload: PublishPluginPayload): Promise<PublishPluginResponse> {
    return request.post("/admin/worker-plugins", payload);
  },

  deprecate(id: string, version: string): Promise<{ status: string }> {
    return request.post(`/admin/worker-plugins/${id}/${version}/deprecate`);
  },

  republish(id: string, version: string): Promise<{ status: string }> {
    return request.post(`/admin/worker-plugins/${id}/${version}/republish`);
  },

  revoke(id: string, version: string): Promise<{ status: string }> {
    return request.post(`/admin/worker-plugins/${id}/${version}/revoke`);
  },

  remove(
    id: string,
    version: string,
  ): Promise<{ id: string; version: string; deleted: boolean }> {
    return request.delete(`/admin/worker-plugins/${id}/${version}`);
  },

  enroll(
    pluginId: string,
    payload: { version: string; enabled: boolean; is_default: boolean },
  ): Promise<PluginEnrollment> {
    return request.put(
      `/admin/worker-plugins/enrollments/${pluginId}`,
      payload,
    );
  },

  unenroll(pluginId: string): Promise<{ plugin_id: string; deleted: boolean }> {
    return request.delete(`/admin/worker-plugins/enrollments/${pluginId}`);
  },
};
