import request from '@/utils/request';

export type RuleType = 'model_name' | 'provider' | 'region' | 'pattern';

export interface PortkeyGateway {
  id: string;
  name: string;
  url: string;
  description?: string;
  isDefault: boolean;
  enabled: boolean;
  containerName?: string;
  port?: number;
  apiKey?: string;
  installStatus?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoutingRule {
  id: string;
  name: string;
  description?: string;
  portkeyGatewayId: string;
  ruleType: RuleType;
  ruleValue: string;
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const portkeyGatewayApi = {
  getAll(): Promise<PortkeyGateway[]> {
    return request.get('/admin/portkey-gateways');
  },

  getById(id: string): Promise<PortkeyGateway> {
    return request.get(`/admin/portkey-gateways/${id}`);
  },

  create(data: {
    name: string;
    url: string;
    description?: string;
    isDefault?: boolean;
    enabled?: boolean;
    containerName?: string;
    port?: number;
  }): Promise<PortkeyGateway> {
    return request.post('/admin/portkey-gateways', data);
  },

  update(id: string, data: {
    name?: string;
    url?: string;
    description?: string;
    isDefault?: boolean;
    enabled?: boolean;
    containerName?: string;
    port?: number;
  }): Promise<PortkeyGateway> {
    return request.put(`/admin/portkey-gateways/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/portkey-gateways/${id}`);
  },

  generateInstallScript(data: {
    name: string;
    url: string;
    port?: number;
    description?: string;
    isDefault?: boolean;
  }): Promise<{
    success: boolean;
    message: string;
    gateway?: PortkeyGateway;
    installScript?: string;
    installCommand?: string;
  }> {
    return request.post('/admin/portkey-gateways/generate-install-script', data);
  },

  getRoutingRules(id: string): Promise<RoutingRule[]> {
    return request.get(`/admin/portkey-gateways/${id}/routing-rules`);
  },

  checkHealth(id: string): Promise<{ success: boolean; latency: number | null; error?: string }> {
    return request.get(`/admin/portkey-gateways/${id}/health`);
  },
};

export const routingRuleApi = {
  getAll(): Promise<RoutingRule[]> {
    return request.get('/admin/routing-rules');
  },

  getById(id: string): Promise<RoutingRule> {
    return request.get(`/admin/routing-rules/${id}`);
  },

  create(data: {
    name: string;
    description?: string;
    portkeyGatewayId: string;
    ruleType: RuleType;
    ruleValue: string;
    priority?: number;
    enabled?: boolean;
  }): Promise<RoutingRule> {
    return request.post('/admin/routing-rules', data);
  },

  update(id: string, data: {
    name?: string;
    description?: string;
    portkeyGatewayId?: string;
    ruleType?: RuleType;
    ruleValue?: string;
    priority?: number;
    enabled?: boolean;
  }): Promise<RoutingRule> {
    return request.put(`/admin/routing-rules/${id}`, data);
  },

  delete(id: string): Promise<{ success: boolean }> {
    return request.delete(`/admin/routing-rules/${id}`);
  },
};

