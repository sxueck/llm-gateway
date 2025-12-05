import { costMappingDb } from '../db/index.js';
import { modelPresetsService } from './model-presets.js';

export class CostMappingService {
  async resolveModelCost(modelName: string) {
    // 1. Check if exact match exists in presets
    const directMatch = modelPresetsService.getModelInfo(modelName);
    if (directMatch) {
      return {
        source: 'direct',
        model: modelName,
        info: directMatch
      };
    }

    // 2. Check mappings
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
}

export const costMappingService = new CostMappingService();