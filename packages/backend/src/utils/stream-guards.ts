import type { ServerResponse } from 'node:http';

type DrainTarget = Pick<ServerResponse, 'destroyed' | 'writableEnded' | 'on' | 'off'>;

/** Resolves on `drain`, and also when the socket closes or `signal` aborts so callers never hang. */
export function waitForDrain(raw: DrainTarget, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (raw.destroyed || raw.writableEnded || signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      raw.off('drain', done);
      raw.off('close', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    raw.on('drain', done);
    raw.on('close', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function writeWithBackpressure(
  raw: ServerResponse,
  data: string,
  signal?: AbortSignal
): Promise<void> {
  if (raw.write(data) === false) {
    await waitForDrain(raw, signal);
  }
}

export class StreamIdleTimeoutError extends Error {
  readonly status = 504;

  constructor(idleMs: number) {
    super(`Upstream stream was idle for ${idleMs}ms`);
    this.name = 'StreamIdleTimeoutError';
  }
}

export class StreamTruncatedError extends Error {
  readonly status = 502;

  constructor(message = 'Upstream stream ended before completion') {
    super(message);
    this.name = 'StreamTruncatedError';
  }
}

/**
 * The SDK stops watching its timeout once headers arrive and swallows abort errors,
 * so a silent upstream needs an explicit idle bound that surfaces as an error.
 */
export function withStreamIdleTimeout<T>(
  stream: AsyncIterable<T>,
  idleMs: number,
  onIdle?: () => void
): AsyncIterable<T> {
  if (!(idleMs > 0)) return stream;

  const abortUpstream = onIdle ?? (() => (stream as any).controller?.abort());

  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let finished = false;
      try {
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StreamIdleTimeoutError(idleMs)), idleMs);
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([iterator.next(), idle]);
          } finally {
            clearTimeout(timer);
          }
          if (result.done) {
            finished = true;
            return;
          }
          yield result.value;
        }
      } catch (error) {
        if (error instanceof StreamIdleTimeoutError) abortUpstream();
        throw error;
      } finally {
        if (!finished) {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        }
      }
    },
  };
}
