import { systemConfigDb } from '../db/index.js';
import { memoryLogger } from './logger.js';

export class UpstreamSslConfigService {
  private skipVerify = false;
  private listeners: Set<() => void> = new Set();

  private async loadConfig() {
    try {
      const cfg = await systemConfigDb.get('skip_upstream_ssl_verify');
      const newValue = cfg ? cfg.value === 'true' : false;
      const changed = this.skipVerify !== newValue;
      this.skipVerify = newValue;
      memoryLogger.debug(
        `Upstream SSL verification config loaded | skipVerify: ${this.skipVerify}`,
        'Config'
      );
      if (changed) {
        this.notifyListeners();
      }
    } catch (error) {
      memoryLogger.error(`Failed to load upstream SSL verification config: ${error}`, 'Config');
      this.skipVerify = false;
    }
  }

  async reloadConfig() {
    await this.loadConfig();
  }

  isSkipVerify(): boolean {
    return this.skipVerify;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        memoryLogger.error(`SSL config change notification failed: ${error}`, 'Config');
      }
    }
  }
}

export const upstreamSslConfigService = new UpstreamSslConfigService();
