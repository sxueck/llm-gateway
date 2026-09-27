import request from "@/utils/request";

export type AlertLevel = "error" | "warning" | "info";

export interface SystemAlert {
  /** 稳定标识；前端按 code 取本地化文案，未知 code 回落到 message */
  code: string;
  level: AlertLevel;
  category: "worker" | "cost" | "provider" | "storage";
  message: string;
  params?: Record<string, string | number>;
  count?: number;
}

export interface AlertsResponse {
  generatedAt: number;
  count: number;
  errors: number;
  alerts: SystemAlert[];
}

const ALERTS_PATH = "/admin/alerts";

export const alertsApi = {
  getList(): Promise<AlertsResponse> {
    return request.get(ALERTS_PATH);
  },
};
