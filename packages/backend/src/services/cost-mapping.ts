import { costMappingDb } from '../db/index.js';
import { modelPresetsService, type ModelPresetInfo } from './model-presets.js';
import type { PricingMatchStrategy } from './pricing-normalize.js';

export function hasTokenPricing(
  info: Partial<ModelPresetInfo> | null | undefined,
): boolean {
  return [
    info?.input_cost_per_token,
    info?.output_cost_per_token,
    info?.cache_read_cost_per_token,
  ].some(value => typeof value === 'number' && Number.isFinite(value));
}

export interface ResolvedModelCost {
  /**
   * direct   = 预设表原名精确命中
   * official = 归一后命中官方实验室牌价（同一模型，只是写法不同）
   * mapping  = model_cost_mappings 里人工配的别名规则
   * approx   = 预设表里没这个型号，取了同家族版本最近邻（价格仅供参考）
   */
  source: 'direct' | 'official' | 'mapping' | 'approx';
  /** 真正取到牌价的预设键；与请求名不同时说明发生了归一 */
  model: string;
  info: ModelPresetInfo;
  /** 牌价所属供应商（anthropic / openai / moonshotai-cn ...） */
  provider?: string;
  strategy?: PricingMatchStrategy;
  /** 仅 source='mapping' 时有值：命中的通配规则与其目标模型 */
  mapping_pattern?: string;
  target_model?: string;
}

export class CostMappingService {
  async resolveModelCost(modelName: string): Promise<ResolvedModelCost | null> {
    // 一次解析同时拿到“命中哪个预设键”与“牌价属于哪家”，便于成本分析展示价源。
    const preset = modelPresetsService.resolvePreset(modelName);

    // 1) 原名在预设表里就是官方裸键：保持旧语义，不走后面的回退
    if (preset && preset.strategy === 'exact' && preset.modelId === modelName) {
      return { source: 'direct', model: modelName, provider: preset.provider, strategy: preset.strategy, info: preset.entry };
    }

    // 2) 人工配的通配映射：明确的用户意图，赢过任何推断
    const mappings = await costMappingDb.getEnabledMappings();
    for (const mapping of mappings) {
      // 通配转正则："gpt-4-*" -> "^gpt-4-.*$"
      const regexPattern = '^' + mapping.pattern.replace(/\*/g, '.*') + '$';
      const regex = new RegExp(regexPattern);

      if (regex.test(modelName)) {
        const targetInfo = modelPresetsService.getModelInfo(mapping.target_model);
        if (targetInfo) {
          return {
            source: 'mapping',
            model: mapping.target_model,
            mapping_pattern: mapping.pattern,
            target_model: mapping.target_model,
            info: targetInfo
          };
        }
      }
    }

    // 3) 官方实验室牌价：同一个模型，只是写法不同（前缀 / [1m] / 快照日期 / 分隔符）
    if (preset && preset.strategy !== 'family') {
      return {
        source: 'official',
        model: preset.modelId,
        provider: preset.provider,
        strategy: preset.strategy,
        info: preset.entry,
      };
    }

    // 4) 同家族版本最近邻：预设表里根本没这个型号，只能给参考价
    if (preset) {
      return {
        source: 'approx',
        model: preset.modelId,
        provider: preset.provider,
        strategy: preset.strategy,
        info: preset.entry,
      };
    }

    return null;
  }

  /**
   * 单一成本口径：token 用量 × 模型单价，与 /api/admin/config/stats 的
   * calculateCostStats 完全一致（缓存读取先取 cache_read_cost_per_token，缺省回退输入价）。
   * 返回 null 表示该模型无价格信息，调用方应展示“未知”而非 0。
   */
  async estimateUsageCost(
    modelName: string | null | undefined,
    usage: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens?: number;
    },
  ): Promise<number | null> {
    if (!modelName) return null;
    const costInfo = await this.resolveModelCost(modelName);
    if (!costInfo?.info) return null;

    const info = costInfo.info;
    let cost = 0;
    if (info.input_cost_per_token && usage.promptTokens) {
      cost += usage.promptTokens * Number(info.input_cost_per_token);
    }
    if (info.output_cost_per_token && usage.completionTokens) {
      cost += usage.completionTokens * Number(info.output_cost_per_token);
    }
    if (usage.cachedTokens) {
      const cacheReadCostPerToken =
        info.cache_read_cost_per_token ?? info.input_cost_per_token;
      if (cacheReadCostPerToken) {
        cost += usage.cachedTokens * Number(cacheReadCostPerToken);
      }
    }
    return cost;
  }
}

export const costMappingService = new CostMappingService();