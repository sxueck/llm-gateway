import request from '@/utils/request';

export interface LogEntry {
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  module?: string;
  metadata?: Record<string, any>;
}

export interface LogStats {
  total: number;
  byLevel: {
    INFO: number;
    WARN: number;
    ERROR: number;
    DEBUG: number;
  };
}

export interface ApiStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  avgResponseTime: number;
  cacheHits: number;
}

export interface TrendData {
  timestamp: number;
  requestCount: number;
  tokenCount: number;
}

export interface PortkeyStatus {
  running: boolean;
  containerId?: string;
  containerName?: string;
  status?: string;
  ports?: string;
  image?: string;
  error?: string;
  docker?: {
    available: boolean;
    version?: string;
    error?: string;
  };
}

export const configApi = {
  getGatewayStatus(): Promise<{ running: boolean; status: number; url: string; endpoint?: string; error?: string }> {
    return request.get('/admin/config/gateway-status');
  },

  getLogs(params?: {
    level?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    limit?: number;
    search?: string;
  }): Promise<{ logs: LogEntry[]; stats: LogStats; total: number }> {
    return request.get('/admin/config/logs', { params });
  },

  getStats(period?: '24h' | '7d' | '30d'): Promise<{
    period: string;
    stats: ApiStats;
    trend: TrendData[];
  }> {
    return request.get('/admin/config/stats', { params: { period } });
  },

  regenerateConfig(): Promise<{ success: boolean; message: string; path?: string }> {
    return request.post('/admin/config/regenerate-config');
  },

  getPortkeyStatus(): Promise<PortkeyStatus> {
    return request.get('/admin/config/portkey/status');
  },

  startPortkey(): Promise<{ success: boolean; message: string; containerId?: string }> {
    return request.post('/admin/config/portkey/start');
  },

  stopPortkey(): Promise<{ success: boolean; message: string }> {
    return request.post('/admin/config/portkey/stop');
  },

  restartPortkey(): Promise<{ success: boolean; message: string }> {
    return request.post('/admin/config/portkey/restart');
  },

  getPortkeyLogs(lines?: number): Promise<{ success: boolean; logs?: string; message?: string }> {
    return request.get('/admin/config/portkey/logs', { params: { lines } });
  },

  removePortkey(): Promise<{ success: boolean; message: string }> {
    return request.post('/admin/config/portkey/remove');
  },

  recreatePortkey(): Promise<{ success: boolean; message: string; containerId?: string }> {
    return request.post('/admin/config/portkey/recreate');
  },

  getRoutingConfigs(): Promise<{ configs: any[] }> {
    return request.get('/admin/config/routing-configs');
  },

  createRoutingConfig(data: {
    name: string;
    description?: string;
    type: string;
    config: any;
    createVirtualModel?: boolean;
    virtualModelName?: string;
    providerId?: string;
    modelAttributes?: any;
  }): Promise<any> {
    return request.post('/admin/config/routing-configs', data);
  },

  updateRoutingConfig(id: string, data: {
    name?: string;
    description?: string;
    type?: string;
    config?: any;
    virtualModelName?: string;
    modelAttributes?: any;
  }): Promise<any> {
    return request.put(`/admin/config/routing-configs/${id}`, data);
  },

  deleteRoutingConfig(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/config/routing-configs/${id}`);
  },

  getSystemSettings(): Promise<{ allowRegistration: boolean; corsEnabled: boolean; publicUrl: string }> {
    return request.get('/admin/config/system-settings');
  },

  getPublicSystemSettings(): Promise<{ allowRegistration: boolean; corsEnabled: boolean; demoMode: boolean; nextCleanupTime: number | null }> {
    return request.get('/public/system-settings');
  },

  updateSystemSettings(data: { allowRegistration?: boolean; corsEnabled?: boolean; publicUrl?: string }): Promise<{ success: boolean }> {
    return request.post('/admin/config/system-settings', data);
  },
};

