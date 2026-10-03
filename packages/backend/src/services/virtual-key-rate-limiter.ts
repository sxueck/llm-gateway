const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;
const CLEANUP_INTERVAL_MS = WINDOW_MS;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the oldest accepted request leaves the window (>= 1 when blocked). */
  retryAfterSeconds: number;
}

/**
 * In-memory RPM limiter enforcing virtual_keys.rate_limit (requests/minute).
 *
 * Ceiling: single-process only — counters are per instance and reset on
 * restart, so N replicas each admit the full limit. Multi-instance
 * deployments need a shared store (Redis INCR + EXPIRE); swap `check`'s
 * storage when that day comes.
 */
class VirtualKeyRateLimiter {
  /** virtualKeyId -> accepted-request timestamps inside the sliding window. */
  private windows = new Map<string, number[]>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(
      () => this.pruneExpired(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref?.();
  }

  private pruneExpired(now: number = Date.now()): void {
    for (const [keyId, timestamps] of this.windows) {
      const alive = timestamps.filter((ts) => now - ts < WINDOW_MS);
      if (alive.length === 0) {
        this.windows.delete(keyId);
      } else if (alive.length !== timestamps.length) {
        this.windows.set(keyId, alive);
      }
    }
  }

  check(
    keyId: string,
    limitPerMinute: number | null | undefined,
    now: number = Date.now(),
  ): RateLimitVerdict {
    const limit =
      typeof limitPerMinute === 'number' && Number.isFinite(limitPerMinute)
        ? Math.floor(limitPerMinute)
        : 0;
    if (!keyId || limit <= 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.startCleanupTimer();

    const timestamps = (this.windows.get(keyId) || []).filter(
      (ts) => now - ts < WINDOW_MS,
    );
    if (timestamps.length >= limit) {
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + WINDOW_MS - now) / 1000),
      );
      this.windows.set(keyId, timestamps);
      return { allowed: false, retryAfterSeconds };
    }

    if (!this.windows.has(keyId) && this.windows.size >= MAX_TRACKED_KEYS) {
      // Bound memory under key churn; an evicted key just restarts its window.
      const oldestKey = this.windows.keys().next().value as
        | string
        | undefined;
      if (oldestKey) this.windows.delete(oldestKey);
    }

    timestamps.push(now);
    this.windows.set(keyId, timestamps);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(keyId?: string): void {
    if (keyId === undefined) {
      this.windows.clear();
    } else {
      this.windows.delete(keyId);
    }
  }

  get trackedKeyCount(): number {
    return this.windows.size;
  }
}

export const virtualKeyRateLimiter = new VirtualKeyRateLimiter();
