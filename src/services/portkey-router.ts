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
      this.cachedRules = modelRoutingRuleDb.getEnabled();
      this.cachedGateways = portkeyGatewayDb.getEnabled();
      this.lastCacheUpdate = now;
      memoryLogger.debug(
        `路由缓存已更新: ${this.cachedRules.length} 条规则, ${this.cachedGateways.length} 个网关`,
        'PortkeyRouter'
      );
    }
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
        memoryLogger.debug(
          `使用默认网关: ${defaultGateway.name} (${defaultGateway.url})`,
          'PortkeyRouter'
        );
        return defaultGateway;
      }
      
      const firstGateway = this.cachedGateways[0];
      memoryLogger.debug(
        `使用第一个可用网关: ${firstGateway.name} (${firstGateway.url})`,
        'PortkeyRouter'
      );
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
      memoryLogger.debug(
        `未匹配到路由规则，使用默认网关: ${defaultGateway.name} (${defaultGateway.url})`,
        'PortkeyRouter'
      );
      return defaultGateway;
    }

    const firstGateway = this.cachedGateways[0];
    memoryLogger.debug(
      `未匹配到路由规则，使用第一个可用网关: ${firstGateway.name} (${firstGateway.url})`,
      'PortkeyRouter'
    );
    return firstGateway;
  }

  private matchRule(rule: ModelRoutingRule, context: RoutingContext): boolean {
    switch (rule.rule_type) {
      case 'model_name':
        if (context.modelName) {
          const matched = this.matchPattern(context.modelName, rule.rule_value);
          if (matched) {
            memoryLogger.debug(
              `模型名称匹配: "${context.modelName}" 匹配规则 "${rule.rule_value}"`,
              'PortkeyRouter'
            );
          }
          return matched;
        }
        break;

      case 'provider':
        if (context.providerId) {
          const provider = providerDb.getById(context.providerId);
          if (provider) {
            const matched = this.matchPattern(provider.name, rule.rule_value) ||
                          this.matchPattern(context.providerId, rule.rule_value);
            if (matched) {
              memoryLogger.debug(
                `提供商匹配: "${provider.name}" 匹配规则 "${rule.rule_value}"`,
                'PortkeyRouter'
              );
            }
            return matched;
          }
        }
        break;

      case 'region':
        if (context.providerId) {
          const provider = providerDb.getById(context.providerId);
          if (provider && provider.base_url) {
            const matched = provider.base_url.toLowerCase().includes(rule.rule_value.toLowerCase());
            if (matched) {
              memoryLogger.debug(
                `地区匹配: "${provider.base_url}" 包含 "${rule.rule_value}"`,
                'PortkeyRouter'
              );
            }
            return matched;
          }
        }
        break;

      case 'pattern':
        try {
          const regex = new RegExp(rule.rule_value, 'i');
          if (context.modelName && regex.test(context.modelName)) {
            memoryLogger.debug(
              `模式匹配: "${context.modelName}" 匹配正则 "${rule.rule_value}"`,
              'PortkeyRouter'
            );
            return true;
          }
          if (context.providerId) {
            const provider = providerDb.getById(context.providerId);
            if (provider && regex.test(provider.name)) {
              memoryLogger.debug(
                `模式匹配: 提供商 "${provider.name}" 匹配正则 "${rule.rule_value}"`,
                'PortkeyRouter'
              );
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
    memoryLogger.debug('路由缓存已清除', 'PortkeyRouter');
  }
}

export const portkeyRouter = new PortkeyRouter();

