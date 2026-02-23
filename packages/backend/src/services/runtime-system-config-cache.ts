import { systemConfigDb } from '../db/index.js';
import { memoryLogger } from './logger.js';

class RuntimeSystemConfigCache {
  private corsEnabled = true;

  async initialize(): Promise<void> {
    await this.reloadCorsEnabled();
  }

  async reloadCorsEnabled(): Promise<void> {
    try {
      const corsEnabledCfg = await systemConfigDb.get('cors_enabled');
      this.corsEnabled = corsEnabledCfg ? corsEnabledCfg.value === 'true' : true;
    } catch (error: any) {
      this.corsEnabled = true;
      memoryLogger.warn(`加载 CORS 缓存失败，使用默认值 true: ${error.message}`, 'ConfigCache');
    }
  }

  getCorsEnabled(): boolean {
    return this.corsEnabled;
  }

  setCorsEnabled(enabled: boolean): void {
    this.corsEnabled = enabled;
  }
}

export const runtimeSystemConfigCache = new RuntimeSystemConfigCache();
