import request from '@/utils/request';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

type Period = '24h' | '7d' | '30d' | 'all';

type AnyRecord = Record<string, any>;

type CircuitBreakerStats = {
  totalTriggers: number;
  maxTriggeredProvider: string;
  maxTriggerCount: number;
};

const ADMIN_CONFIG_BASE_PATH = '/admin/config';
const PUBLIC_BASE_PATH = '/public';

const withId = (basePath: string, id: string) => `${basePath}/${id}`;

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  module?: string;
  metadata?: AnyRecord;
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

export interface CostStats {
  totalCost: number;
  modelCosts: Array<{
    model: string;
    cost: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
  }>;
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
  dbSize?: number;
  dbUptime?: number;
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

export interface ModelResponseTimeStat {
  model: string;
  created_at: number;
  response_time: number;
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

export interface RequestSourceGeoInfo {
  ip: string;
  country?: string;
  province?: string;
  city?: string;
  isp?: string;
  ispZh?: string;
  locationZh: string;
  asn?: string;
  asOrganization?: string;
  latitude?: number;
  longitude?: number;
}

export interface RequestSourceEntry {
  ip: string;
  geo: RequestSourceGeoInfo | null;
  timestamp: number;
  count: number;
  type: 'normal' | 'blocked';
  userAgent?: string | null;
  blockedReason?: string | null;
}

export interface RequestSourceStats {
  lastRequest: {
    ip: string;
    geo: RequestSourceGeoInfo | null;
    timestamp: number;
    userAgent?: string | null;
  } | null;
  lastBlocked: {
    ip: string;
    geo: RequestSourceGeoInfo | null;
    timestamp: number;
    reason?: string | null;
    source?: 'manual' | 'threat';
  } | null;
  recentSources?: RequestSourceEntry[];
}

export interface ThreatIpStats {
  blockedCount: number;
  totalThreatIps: number;
  lastBlockedIp: string | null;
  lastBlockedAt: number | null;
  lastUpdated: number | null;
}

export interface AifwStats {
  maskedCount: number;
  lastMaskedAt: number;
  enabled: boolean;
}

type GetLogsParams = {
  level?: LogLevel;
  limit?: number;
  search?: string;
};

type GetLogsResponse = {
  logs: LogEntry[];
  stats: LogStats;
  total: number;
};

type GetStatsResponse = {
  period: string;
  stats: ApiStats;
  trend: VirtualKeyTrend[];
  expertRoutingStats: ExpertRoutingStats;
  modelStats: ModelStat[];
  modelResponseTimeStats: ModelResponseTimeStat[];
  circuitBreakerStats?: CircuitBreakerStats;
  costStats: CostStats | null;
  requestSourceStats?: RequestSourceStats;
  threatIpStats?: ThreatIpStats;
  aifwStats?: AifwStats;
};

type LookupRequestSourceResponse = {
  ip: string;
  geo: RequestSourceGeoInfo | null;
  blocked: boolean;
  blockedReason: string | null;
  lastSeen: number | null;
  userAgent: string | null;
};

type BlockRequestSourceRequest = { ip: string; reason?: string };

type BlockRequestSourceResponse = {
  success: boolean;
  blocked: {
    ip: string;
    reason: string | null;
    timestamp: number;
  };
};

type RoutingConfigsResponse = { configs: any[] };

type CreateRoutingConfigRequest = {
  name: string;
  description?: string;
  type: string;
  config: any;
  createVirtualModel?: boolean;
  virtualModelName?: string;
  providerId?: string;
  modelAttributes?: any;
};

type UpdateRoutingConfigRequest = {
  name?: string;
  description?: string;
  type?: string;
  config?: any;
  virtualModelName?: string;
  modelAttributes?: any;
};

type DeleteResponse = { success: boolean };

type AntiBotSettings = {
  enabled: boolean;
  blockBots: boolean;
  blockSuspicious: boolean;
  blockThreatIPs: boolean;
  logOnly: boolean;
  logHeaders: boolean;
  allowedUserAgents: string[];
  blockedUserAgents: string[];
};

type AifwSettings = {
  enabled: boolean;
  baseUrl: string;
  failOpen: boolean;
  timeoutMs: number;
  maskConfig: AnyRecord;
  httpApiKeySet: boolean;
};

type SystemSettingsResponse = {
  allowRegistration: boolean;
  corsEnabled: boolean;
  publicUrl: string;
  litellmCompatEnabled: boolean;
  healthMonitoringEnabled: boolean;
  persistentMonitoringEnabled: boolean;
  developerDebugEnabled: boolean;
  developerDebugExpiresAt: number | null;
  dashboardHideRequestSourceCard: boolean;
  forwardClientUserAgent: boolean;
  antiBot: AntiBotSettings;
  aifw: AifwSettings;
};

type PublicSystemSettingsResponse = {
  allowRegistration: boolean;
  corsEnabled: boolean;
  demoMode: boolean;
  nextCleanupTime: number | null;
  dashboardHideRequestSourceCard: boolean;
};

type UpdateSystemSettingsRequest = {
  allowRegistration?: boolean;
  corsEnabled?: boolean;
  publicUrl?: string;
  litellmCompatEnabled?: boolean;
  healthMonitoringEnabled?: boolean;
  persistentMonitoringEnabled?: boolean;
  developerDebugEnabled?: boolean;
  dashboardHideRequestSourceCard?: boolean;
  forwardClientUserAgent?: boolean;
  antiBot?: {
    enabled?: boolean;
    blockBots?: boolean;
    blockSuspicious?: boolean;
    blockThreatIPs?: boolean;
    logOnly?: boolean;
    logHeaders?: boolean;
    allowedUserAgents?: string[];
    blockedUserAgents?: string[];
  };
  aifw?: {
    enabled?: boolean;
    baseUrl?: string;
    httpApiKey?: string;
    failOpen?: boolean;
    timeoutMs?: number;
    maskConfigJson?: string;
  };
};

type HealthTargetsResponse = { targets: any[] };

type CreateHealthTargetRequest = {
  type: 'model' | 'virtual_model';
  target_id: string;
  check_interval_seconds?: number;
  check_prompt?: string;
};

type UpdateHealthTargetRequest = {
  display_title?: string | null;
  enabled?: boolean;
  check_interval_seconds?: number;
  check_prompt?: string;
};

const adminConfigPath = (suffix: string) => `${ADMIN_CONFIG_BASE_PATH}${suffix}`;

const ADMIN_LOGS_PATH = adminConfigPath('/logs');
const ADMIN_STATS_PATH = adminConfigPath('/stats');
const ADMIN_REQUEST_SOURCES_LOOKUP_PATH = adminConfigPath('/request-sources/lookup');
const ADMIN_REQUEST_SOURCES_BLOCK_PATH = adminConfigPath('/request-sources/block');
const ADMIN_ROUTING_CONFIGS_PATH = adminConfigPath('/routing-configs');
const ADMIN_SYSTEM_SETTINGS_PATH = adminConfigPath('/system-settings');
const ADMIN_HEALTH_TARGETS_PATH = adminConfigPath('/health-targets');

const PUBLIC_SYSTEM_SETTINGS_PATH = `${PUBLIC_BASE_PATH}/system-settings`;

export const configApi = {
  getLogs(params?: GetLogsParams): Promise<GetLogsResponse> {
    return request.get(ADMIN_LOGS_PATH, { params });
  },

  getStats(period?: Period): Promise<GetStatsResponse> {
    return request.get(ADMIN_STATS_PATH, { params: { period } });
  },

  lookupRequestSource(ip: string): Promise<LookupRequestSourceResponse> {
    return request.get(ADMIN_REQUEST_SOURCES_LOOKUP_PATH, { params: { ip } });
  },

  blockRequestSource(data: BlockRequestSourceRequest): Promise<BlockRequestSourceResponse> {
    return request.post(ADMIN_REQUEST_SOURCES_BLOCK_PATH, data);
  },

  getRoutingConfigs(): Promise<RoutingConfigsResponse> {
    return request.get(ADMIN_ROUTING_CONFIGS_PATH);
  },

  createRoutingConfig(data: CreateRoutingConfigRequest): Promise<any> {
    return request.post(ADMIN_ROUTING_CONFIGS_PATH, data);
  },

  updateRoutingConfig(id: string, data: UpdateRoutingConfigRequest): Promise<any> {
    return request.put(withId(ADMIN_ROUTING_CONFIGS_PATH, id), data);
  },

  deleteRoutingConfig(id: string): Promise<DeleteResponse> {
    return request.delete(withId(ADMIN_ROUTING_CONFIGS_PATH, id));
  },

  getSystemSettings(): Promise<SystemSettingsResponse> {
    return request.get(ADMIN_SYSTEM_SETTINGS_PATH);
  },

  getPublicSystemSettings(): Promise<PublicSystemSettingsResponse> {
    return request.get(PUBLIC_SYSTEM_SETTINGS_PATH);
  },

  updateSystemSettings(data: UpdateSystemSettingsRequest): Promise<DeleteResponse> {
    return request.post(ADMIN_SYSTEM_SETTINGS_PATH, data);
  },

  getHealthTargets(): Promise<HealthTargetsResponse> {
    return request.get(ADMIN_HEALTH_TARGETS_PATH);
  },

  createHealthTarget(data: CreateHealthTargetRequest): Promise<any> {
    return request.post(ADMIN_HEALTH_TARGETS_PATH, data);
  },

  updateHealthTarget(id: string, data: UpdateHealthTargetRequest): Promise<any> {
    return request.put(withId(ADMIN_HEALTH_TARGETS_PATH, id), data);
  },

  deleteHealthTarget(id: string): Promise<DeleteResponse> {
    return request.delete(withId(ADMIN_HEALTH_TARGETS_PATH, id));
  },
};
