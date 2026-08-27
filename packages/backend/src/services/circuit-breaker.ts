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
  /** 配额耗尽等场景下的绝对锁定到期时刻（ms）；存在时优先于相对 timeout。 */
  openUntil?: number;
}

export class CircuitBreaker {
  private stats: Map<string, ProviderStats> = new Map();
  private config: CircuitBreakerConfig;

  private extractProviderId(circuitKey: string): string | undefined {
    if (typeof circuitKey !== 'string') {
      return undefined;
    }

    const normalizedKey = circuitKey.trim();
    if (!normalizedKey) {
      return undefined;
    }

    const [providerId] = normalizedKey.split('::');
    return providerId || normalizedKey;
  }

  constructor(config?: Partial<CircuitBreakerConfig>) {
    const rawHalfOpenMaxAttempts = config?.halfOpenMaxAttempts ?? 3;
    if (rawHalfOpenMaxAttempts < 1) {
      throw new Error('halfOpenMaxAttempts must be >= 1');
    }

    this.config = {
      failureThreshold: config?.failureThreshold || 2,
      successThreshold: config?.successThreshold || 2,
      timeout: config?.timeout || 10000,
      halfOpenMaxAttempts: rawHalfOpenMaxAttempts
    };
  }

  private getStats(circuitKey: string): ProviderStats {
    if (!this.stats.has(circuitKey)) {
      this.stats.set(circuitKey, {
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        state: CircuitState.CLOSED,
        halfOpenAttempts: 0,
        triggerCount: 0,
        openUntil: undefined
      });
    }
    return this.stats.get(circuitKey)!;
  }

  isAvailable(circuitKey: string): boolean {
    const stats = this.getStats(circuitKey);

    if (stats.state === CircuitState.CLOSED) {
      return true;
    }

    if (stats.state === CircuitState.OPEN) {
      // 配额重置锁定：锁定到指定绝对时刻，未到期则保持打开
      if (stats.openUntil && stats.openUntil > Date.now()) {
        return false;
      }
      const now = Date.now();
      if (now - stats.lastFailureTime >= this.config.timeout) {
        stats.state = CircuitState.HALF_OPEN;
        stats.halfOpenAttempts = 0;
        stats.openUntil = undefined;
        memoryLogger.info(
          `熔断器进入半开状态 | key: ${circuitKey}`,
          'CircuitBreaker'
        );

        stats.halfOpenAttempts++;
        return true;
      }
      return false;
    }

    if (stats.state === CircuitState.HALF_OPEN) {
      if (stats.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        return false;
      }
      stats.halfOpenAttempts++;
      return true;
    }

    return true;
  }

  peekAvailability(circuitKey: string): boolean {
    const stats = this.getStats(circuitKey);

    if (stats.state === CircuitState.CLOSED) {
      return true;
    }

    if (stats.state === CircuitState.OPEN) {
      if (stats.openUntil && stats.openUntil > Date.now()) {
        return false;
      }
      return Date.now() - stats.lastFailureTime >= this.config.timeout;
    }

    if (stats.state === CircuitState.HALF_OPEN) {
      return stats.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }

    return true;
  }

  recordSuccess(circuitKey: string): void {
    const stats = this.getStats(circuitKey);

    if (stats.state === CircuitState.HALF_OPEN) {
      stats.successes++;

      if (stats.successes >= this.config.successThreshold) {
        stats.state = CircuitState.CLOSED;
        stats.failures = 0;
        stats.successes = 0;
        stats.halfOpenAttempts = 0;
        stats.openUntil = undefined;
        memoryLogger.info(
          `熔断器恢复正常 | key: ${circuitKey}`,
          'CircuitBreaker'
        );
      }
    } else if (stats.state === CircuitState.CLOSED) {
      stats.failures = Math.max(0, stats.failures - 1);
    }
  }

  recordFailure(circuitKey: string, error?: any, openUntil?: number): void {
    const stats = this.getStats(circuitKey);
    const providerId = this.extractProviderId(circuitKey);

    // 配额重置锁定：仅当 openUntil 是未来的绝对时刻才生效
    const lockUntil = (typeof openUntil === 'number' && openUntil > Date.now()) ? openUntil : undefined;

    const persistTriggerStats = () => {
      if (!providerId) {
        memoryLogger.warn(
          `跳过持久化熔断器触发统计: 无效 provider key=${String(circuitKey)}`,
          'CircuitBreaker'
        );
        return;
      }

      // Persist trigger stats asynchronously (no need to await)
      circuitBreakerStatsRepository.incrementTrigger(providerId).catch(err => {
        memoryLogger.error(`持久化熔断器触发统计失败: ${err.message}`, 'CircuitBreaker');
      });
    };

    stats.failures++;
    stats.lastFailureTime = Date.now();

    if (stats.state === CircuitState.HALF_OPEN) {
      stats.state = CircuitState.OPEN;
      stats.successes = 0;
      stats.halfOpenAttempts = 0;
      if (lockUntil) {
        stats.openUntil = lockUntil;
      }
      stats.triggerCount = (stats.triggerCount || 0) + 1;
      persistTriggerStats();
      memoryLogger.warn(
        `熔断器重新打开 | key: ${circuitKey} | provider: ${providerId} | error: ${error?.message || 'unknown'}`,
        'CircuitBreaker'
      );
    } else if (stats.state === CircuitState.CLOSED) {
      // 配额 429：第一次就立即熔断并锁定到重置时刻；否则累计到失败阈值再打开
      if (lockUntil || stats.failures >= this.config.failureThreshold) {
        stats.state = CircuitState.OPEN;
        stats.openUntil = lockUntil;
        stats.triggerCount = (stats.triggerCount || 0) + 1;
        persistTriggerStats();
        memoryLogger.warn(
          `熔断器打开 | key: ${circuitKey} | provider: ${providerId} | ${lockUntil ? `配额锁定至 ${new Date(lockUntil).toISOString()}` : `failures: ${stats.failures}`}`,
          'CircuitBreaker'
        );
      }
    } else if (stats.state === CircuitState.OPEN) {
      // 已打开：若新的锁定时刻更晚，则延长锁定
      if (lockUntil && (!stats.openUntil || lockUntil > stats.openUntil)) {
        stats.openUntil = lockUntil;
        memoryLogger.info(
          `熔断器锁定延长至 ${new Date(lockUntil).toISOString()} | key: ${circuitKey}`,
          'CircuitBreaker'
        );
      }
    }
  }

  getState(circuitKey: string): CircuitState {
    return this.getStats(circuitKey).state;
  }

  /**
   * 计算熔断器预计恢复（转为半开试探）的绝对时刻（epoch ms）。
   * - 配额锁定（openUntil）优先；
   * - 否则按相对超时 lastFailureTime + timeout；
   * - 非 OPEN 状态、或窗口已过期（相对超时场景）返回 null。
   */
  getCloseAt(circuitKey: string): number | null {
    const stats = this.getStats(circuitKey);
    if (stats.state !== CircuitState.OPEN) {
      return null;
    }
    const now = Date.now();
    if (stats.openUntil && stats.openUntil > now) {
      return stats.openUntil;
    }
    const relativeClose = stats.lastFailureTime + this.config.timeout;
    return relativeClose > now ? relativeClose : null;
  }

  getProviderStats(circuitKey: string): ProviderStats {
    return { ...this.getStats(circuitKey) };
  }

  getAllStats(): Map<string, ProviderStats> {
    const result = new Map<string, ProviderStats>();
    this.stats.forEach((stats, key) => {
      result.set(key, { ...stats });
    });
    return result;
  }

  reset(circuitKey: string): void {
    this.stats.delete(circuitKey);
    memoryLogger.info(
      `熔断器重置 | key: ${circuitKey}`,
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

    this.stats.forEach((stats, circuitKey) => {
      const count = stats.triggerCount || 0;
      totalTriggers += count;
      if (count > maxTriggerCount) {
        maxTriggerCount = count;
        maxTriggeredProvider = circuitKey;
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
