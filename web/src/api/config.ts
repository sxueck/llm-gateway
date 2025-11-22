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
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  avgResponseTime: number;
  cacheHits: number;
  promptCacheHits: number;
  cacheSavedTokens: number;
}

export interface ExpertRoutingStats {
  totalRequests: number;
  avgClassificationTime: number;
}

export interface ModelStat {
  model: string;
  provider_name: string;
  request_count: number;
  total_tokens: number;
  avg_response_time: number;
}

export interface TrendData {
  timestamp: number;
  requestCount: number;
  tokenCount: number;
}

export interface TrendDataPoint {
  timestamp: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  tokenCount: number;
}

export interface VirtualKeyTrend {
  virtualKeyId: string;
  virtualKeyName: string;
  data: TrendDataPoint[];
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
    trend: VirtualKeyTrend[];
    expertRoutingStats: ExpertRoutingStats;
    modelStats: ModelStat[];
  }> {
    return request.get('/admin/config/stats', { params: { period } });
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

  getSystemSettings(): Promise<{
    allowRegistration: boolean;
    corsEnabled: boolean;
    publicUrl: string;
    litellmCompatEnabled: boolean;
    healthMonitoringEnabled: boolean;
    persistentMonitoringEnabled: boolean;
    antiBot: {
      enabled: boolean;
      blockBots: boolean;
      blockSuspicious: boolean;
      logOnly: boolean;
      logHeaders: boolean;
      allowedUserAgents: string[];
      blockedUserAgents: string[];
    };
  }> {
    return request.get('/admin/config/system-settings');
  },

  getPublicSystemSettings(): Promise<{ allowRegistration: boolean; corsEnabled: boolean; demoMode: boolean; nextCleanupTime: number | null }> {
    return request.get('/public/system-settings');
  },

  updateSystemSettings(data: {
    allowRegistration?: boolean;
    corsEnabled?: boolean;
    publicUrl?: string;
    litellmCompatEnabled?: boolean;
    healthMonitoringEnabled?: boolean;
    persistentMonitoringEnabled?: boolean;
    antiBot?: {
      enabled?: boolean;
      blockBots?: boolean;
      blockSuspicious?: boolean;
      logOnly?: boolean;
      logHeaders?: boolean;
      allowedUserAgents?: string[];
      blockedUserAgents?: string[];
    };
  }): Promise<{ success: boolean }> {
    return request.post('/admin/config/system-settings', data);
  },

  getHealthTargets(): Promise<{ targets: any[] }> {
    return request.get('/admin/config/health-targets');
  },

  createHealthTarget(data: {
    type: 'model' | 'virtual_model';
    target_id: string;
    check_interval_seconds?: number;
    check_prompt?: string;
  }): Promise<any> {
    return request.post('/admin/config/health-targets', data);
  },

  updateHealthTarget(id: string, data: {
    enabled?: boolean;
    check_interval_seconds?: number;
    check_prompt?: string;
  }): Promise<any> {
    return request.put(`/admin/config/health-targets/${id}`, data);
  },

  deleteHealthTarget(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/config/health-targets/${id}`);
  },
};

