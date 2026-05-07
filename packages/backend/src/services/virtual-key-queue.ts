export interface QueueConfig {
  maxConcurrency: number;
  maxQueueSize: number;
  queueTimeoutMs: number;
}

export interface AcquireGranted {
  granted: true;
  release: () => void;
}

export interface AcquireRejected {
  granted: false;
  reason: 'queue_full' | 'timeout' | 'cancelled';
}

export type AcquireResult = AcquireGranted | AcquireRejected;

interface Waiter {
  resolve: (result: AcquireResult) => void;
  timer: NodeJS.Timeout | null;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
}

class KeyQueue {
  activeCount = 0;
  waiters: Waiter[] = [];
}

export class VirtualKeyQueueService {
  private config: QueueConfig;
  private queues = new Map<string, KeyQueue>();

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 20,
      maxQueueSize: config.maxQueueSize ?? 200,
      queueTimeoutMs: config.queueTimeoutMs ?? 30000,
    };
  }

  configure(config: Partial<QueueConfig>): void {
    if (config.maxConcurrency !== undefined) {
      this.config.maxConcurrency = config.maxConcurrency;
    }
    if (config.maxQueueSize !== undefined) {
      this.config.maxQueueSize = config.maxQueueSize;
    }
    if (config.queueTimeoutMs !== undefined) {
      this.config.queueTimeoutMs = config.queueTimeoutMs;
    }
  }

  acquire(virtualKey: string, signal?: AbortSignal): Promise<AcquireResult> {
    return new Promise((resolve) => {
      const queue = this.getQueue(virtualKey);

      if (queue.activeCount < this.config.maxConcurrency) {
        queue.activeCount++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          queue.activeCount = Math.max(0, queue.activeCount - 1);
          this.promoteNext(virtualKey);
        };
        resolve({ granted: true, release });
        return;
      }

      if (queue.waiters.length >= this.config.maxQueueSize) {
        resolve({ granted: false, reason: 'queue_full' });
        return;
      }

      const waiter: Waiter = {
        resolve,
        timer: null,
        signal,
        onAbort: null,
      };

      waiter.timer = setTimeout(() => {
        this.removeWaiter(virtualKey, queue, waiter);
        resolve({ granted: false, reason: 'timeout' });
      }, this.config.queueTimeoutMs);

      if (signal) {
        const onAbort = () => {
          this.removeWaiter(virtualKey, queue, waiter);
          resolve({ granted: false, reason: 'cancelled' });
        };
        waiter.onAbort = onAbort;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      queue.waiters.push(waiter);
    });
  }

  private getQueue(virtualKey: string): KeyQueue {
    let queue = this.queues.get(virtualKey);
    if (!queue) {
      queue = new KeyQueue();
      this.queues.set(virtualKey, queue);
    }
    return queue;
  }

  private removeWaiter(virtualKey: string, queue: KeyQueue, waiter: Waiter): void {
    const index = queue.waiters.indexOf(waiter);
    if (index !== -1) {
      queue.waiters.splice(index, 1);
    }
    if (waiter.onAbort && waiter.signal) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.onAbort = null;
    }
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    if (queue.activeCount === 0 && queue.waiters.length === 0) {
      this.queues.delete(virtualKey);
    }
  }

  private promoteNext(virtualKey: string): void {
    const queue = this.queues.get(virtualKey);
    if (!queue) return;

    while (queue.waiters.length > 0) {
      const waiter = queue.waiters.shift()!;
      if (waiter.timer) {
        clearTimeout(waiter.timer);
        waiter.timer = null;
      }
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.onAbort = null;
      }

      queue.activeCount++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        queue.activeCount = Math.max(0, queue.activeCount - 1);
        this.promoteNext(virtualKey);
      };
      waiter.resolve({ granted: true, release });
      return;
    }

    if (queue.activeCount === 0 && queue.waiters.length === 0) {
      this.queues.delete(virtualKey);
    }
  }
}

export const virtualKeyQueueService = new VirtualKeyQueueService();
