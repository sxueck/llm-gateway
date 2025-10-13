import { portkeyGatewayDb, modelRoutingRuleDb, providerDb, modelDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { PortkeyGateway, ModelRoutingRule } from '../types/index.js';

export interface RoutingContext {
  modelName?: string;
  modelId?: string;
  providerId?: string;
  virtualKeyId?: string;
}

export class PortkeyRouter {
  private cachedRules: ModelRoutingRule[] = [];
  private cachedGateways: PortkeyGateway[] = [];
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 60000;

  private updateCache() {
    const now = Date.now();
    if (now - this.lastCacheUpdate > this.CACHE_TTL) {
      const rawRules = modelRoutingRuleDb.getEnabled();
      this.cachedRules = rawRules.map(rule => ({
        ...rule,
        rule_type: this.validateRuleType(rule.rule_type)
      }));
      this.cachedGateways = portkeyGatewayDb.getEnabled();
      this.lastCacheUpdate = now;
    }
  }

  private validateRuleType(ruleType: string): 'model_name' | 'provider' | 'region' | 'pattern' {
    const validTypes = ['model_name', 'provider', 'region', 'pattern'] as const;
    if (validTypes.includes(ruleType as any)) {
      return ruleType as 'model_name' | 'provider' | 'region' | 'pattern';
    }
    memoryLogger.warn(`无效的路由规则类型: ${ruleType}, 使用默认类型 'model_name'`, 'PortkeyRouter');
    return 'model_name';
  }

  selectGateway(context: RoutingContext): PortkeyGateway | undefined {
    this.updateCache();

    if (this.cachedGateways.length === 0) {
      memoryLogger.warn('没有可用的 Portkey Gateway', 'PortkeyRouter');
      return undefined;
    }

    if (this.cachedRules.length === 0) {
      const defaultGateway = this.cachedGateways.find(g => g.is_default === 1);
      if (defaultGateway) {
        return defaultGateway;
      }

      const firstGateway = this.cachedGateways[0];
      return firstGateway;
    }

    const sortedRules = [...this.cachedRules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.matchRule(rule, context)) {
        const gateway = this.cachedGateways.find(g => g.id === rule.portkey_gateway_id);
        if (gateway) {
          memoryLogger.info(
            `路由匹配成功: 规则="${rule.name}" (${rule.rule_type}:${rule.rule_value}) -> 网关="${gateway.name}" (${gateway.url})`,
            'PortkeyRouter'
          );
          return gateway;
        } else {
          memoryLogger.warn(
            `路由规则 "${rule.name}" 指向的网关不存在或已禁用: ${rule.portkey_gateway_id}`,
            'PortkeyRouter'
          );
        }
      }
    }

    const defaultGateway = this.cachedGateways.find(g => g.is_default === 1);
    if (defaultGateway) {
      return defaultGateway;
    }

    const firstGateway = this.cachedGateways[0];
    return firstGateway;
  }

  private matchRule(rule: ModelRoutingRule, context: RoutingContext): boolean {
    switch (rule.rule_type) {
      case 'model_name':
        if (context.modelName) {
          return this.matchPattern(context.modelName, rule.rule_value);
        }
        break;

      case 'provider':
        if (context.providerId) {
          const provider = providerDb.getById(context.providerId);
          if (provider) {
            return this.matchPattern(provider.name, rule.rule_value) ||
                   this.matchPattern(context.providerId, rule.rule_value);
          }
        }
        break;

      case 'region':
        if (context.providerId) {
          const provider = providerDb.getById(context.providerId);
          if (provider && provider.base_url) {
            return provider.base_url.toLowerCase().includes(rule.rule_value.toLowerCase());
          }
        }
        break;

      case 'pattern':
        try {
          const regex = new RegExp(rule.rule_value, 'i');
          if (context.modelName && regex.test(context.modelName)) {
            return true;
          }
          if (context.providerId) {
            const provider = providerDb.getById(context.providerId);
            if (provider && regex.test(provider.name)) {
              return true;
            }
          }
        } catch (error: any) {
          memoryLogger.error(
            `正则表达式无效: ${rule.rule_value} - ${error.message}`,
            'PortkeyRouter'
          );
        }
        break;
    }

    return false;
  }

  private matchPattern(value: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(value);
    }
    
    return value.toLowerCase() === pattern.toLowerCase();
  }

  clearCache() {
    this.lastCacheUpdate = 0;
  }
}

export const portkeyRouter = new PortkeyRouter();

