import { memoryLogger } from './logger.js';
import { circuitBreakerStatsRepository } from '../db/repositories/circuit-breaker-stats.repository.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  halfOpenMaxAttempts: number;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

interface ProviderStats {
  failures: number;
  successes: number;
  lastFailureTime: number;
  state: CircuitState;
  halfOpenAttempts: number;
  triggerCount: number;
}

export class CircuitBreaker {
  private stats: Map<string, ProviderStats> = new Map();
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold || 2,
      successThreshold: config?.successThreshold || 2,
      timeout: config?.timeout || 120000,
      halfOpenMaxAttempts: config?.halfOpenMaxAttempts || 3
    };
  }

  private getStats(providerId: string): ProviderStats {
    if (!this.stats.has(providerId)) {
      this.stats.set(providerId, {
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        state: CircuitState.CLOSED,
        halfOpenAttempts: 0,
        triggerCount: 0
      });
    }
    return this.stats.get(providerId)!;
  }

  isAvailable(providerId: string): boolean {
    const stats = this.getStats(providerId);

    if (stats.state === CircuitState.CLOSED) {
      return true;
    }

    if (stats.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - stats.lastFailureTime >= this.config.timeout) {
        stats.state = CircuitState.HALF_OPEN;
        stats.halfOpenAttempts = 0;
        memoryLogger.info(
          `熔断器进入半开状态 | provider: ${providerId}`,
          'CircuitBreaker'
        );
        return true;
      }
      return false;
    }

    if (stats.state === CircuitState.HALF_OPEN) {
      return stats.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }

    return true;
  }

  recordSuccess(providerId: string): void {
    const stats = this.getStats(providerId);

    if (stats.state === CircuitState.HALF_OPEN) {
      stats.successes++;
      stats.halfOpenAttempts++;

      if (stats.successes >= this.config.successThreshold) {
        stats.state = CircuitState.CLOSED;
        stats.failures = 0;
        stats.successes = 0;
        stats.halfOpenAttempts = 0;
        memoryLogger.info(
          `熔断器恢复正常 | provider: ${providerId}`,
          'CircuitBreaker'
        );
      }
    } else if (stats.state === CircuitState.CLOSED) {
      stats.failures = Math.max(0, stats.failures - 1);
    }
  }

  recordFailure(providerId: string, error?: any): void {
    const stats = this.getStats(providerId);
    stats.failures++;
    stats.lastFailureTime = Date.now();

    if (stats.state === CircuitState.HALF_OPEN) {
      stats.state = CircuitState.OPEN;
      stats.successes = 0;
      stats.halfOpenAttempts = 0;
      stats.triggerCount = (stats.triggerCount || 0) + 1;
      // Persist trigger stats asynchronously (no need to await)
      circuitBreakerStatsRepository.incrementTrigger(providerId).catch(err => {
        memoryLogger.error(`持久化熔断器触发统计失败: ${err.message}`, 'CircuitBreaker');
      });
      memoryLogger.warn(
        `熔断器重新打开 | provider: ${providerId} | error: ${error?.message || 'unknown'}`,
        'CircuitBreaker'
      );
    } else if (stats.state === CircuitState.CLOSED) {
      if (stats.failures >= this.config.failureThreshold) {
        stats.state = CircuitState.OPEN;
        stats.triggerCount = (stats.triggerCount || 0) + 1;
        // Persist trigger stats asynchronously (no need to await)
        circuitBreakerStatsRepository.incrementTrigger(providerId).catch(err => {
          memoryLogger.error(`持久化熔断器触发统计失败: ${err.message}`, 'CircuitBreaker');
        });
        memoryLogger.warn(
          `熔断器打开 | provider: ${providerId} | failures: ${stats.failures}`,
          'CircuitBreaker'
        );
      }
    }
  }

  getState(providerId: string): CircuitState {
    return this.getStats(providerId).state;
  }

  getProviderStats(providerId: string): ProviderStats {
    return { ...this.getStats(providerId) };
  }

  getAllStats(): Map<string, ProviderStats> {
    const result = new Map<string, ProviderStats>();
    this.stats.forEach((stats, providerId) => {
      result.set(providerId, { ...stats });
    });
    return result;
  }

  reset(providerId: string): void {
    this.stats.delete(providerId);
    memoryLogger.info(
      `熔断器重置 | provider: ${providerId}`,
      'CircuitBreaker'
    );
  }

  resetAll(): void {
    this.stats.clear();
    memoryLogger.info('所有熔断器已重置', 'CircuitBreaker');
  }

  getGlobalStats() {
    let totalTriggers = 0;
    let maxTriggeredProvider = '-';
    let maxTriggerCount = 0;

    this.stats.forEach((stats, providerId) => {
      const count = stats.triggerCount || 0;
      totalTriggers += count;
      if (count > maxTriggerCount) {
        maxTriggerCount = count;
        maxTriggeredProvider = providerId;
      }
    });

    return {
      totalTriggers,
      maxTriggeredProvider,
      maxTriggerCount
    };
  }
}

export const circuitBreaker = new CircuitBreaker();

