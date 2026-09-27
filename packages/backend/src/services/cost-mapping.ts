import { costMappingDb } from '../db/index.js';
import { modelPresetsService } from './model-presets.js';

export class CostMappingService {
  async resolveModelCost(modelName: string) {
    const directMatch = modelPresetsService.getModelInfo(modelName);
    if (directMatch) {
      return {
        source: 'direct',
        model: modelName,
        info: directMatch
      };
    }

    const mappings = await costMappingDb.getEnabledMappings();
    for (const mapping of mappings) {
      // Convert wildcard pattern to regex
      // e.g. "gpt-4-*" -> "^gpt-4-.*$"
      const regexPattern = '^' + mapping.pattern.replace(/\*/g, '.*') + '$';
      const regex = new RegExp(regexPattern);
      
      if (regex.test(modelName)) {
        const targetInfo = modelPresetsService.getModelInfo(mapping.target_model);
        if (targetInfo) {
          return {
            source: 'mapping',
            mapping_pattern: mapping.pattern,
            target_model: mapping.target_model,
            info: targetInfo
          };
        }
      }
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