import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';

import {
  StreamIdleTimeoutError,
  waitForDrain,
  withStreamIdleTimeout,
  writeWithBackpressure,
} from './stream-guards.js';

function createRaw() {
  const raw: any = new EventEmitter();
  raw.destroyed = false;
  raw.writableEnded = false;
  raw.write = () => false;
  return raw;
}

describe('waitForDrain', () => {
  test('resolves on drain', async () => {
    const raw = createRaw();
    const pending = waitForDrain(raw);
    raw.emit('drain');
    await pending;
    expect(raw.listenerCount('drain')).toBe(0);
  });

  test('resolves when the socket closes instead of hanging', async () => {
    const raw = createRaw();
    const pending = waitForDrain(raw);
    raw.emit('close');
    await pending;
    expect(raw.listenerCount('close')).toBe(0);
  });

  test('resolves when the abort signal fires', async () => {
    const raw = createRaw();
    const controller = new AbortController();
    const pending = waitForDrain(raw, controller.signal);
    controller.abort();
    await pending;
    expect(raw.listenerCount('drain')).toBe(0);
  });

  test('resolves immediately for a destroyed response', async () => {
    const raw = createRaw();
    raw.destroyed = true;
    await waitForDrain(raw);
  });
});

describe('writeWithBackpressure', () => {
  test('does not wait when write accepts the data', async () => {
    const raw = createRaw();
    raw.write = () => true;
    await writeWithBackpressure(raw, 'x');
  });

  test('waits for drain when write reports backpressure', async () => {
    const raw = createRaw();
    let resolved = false;
    const pending = writeWithBackpressure(raw, 'x').then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);
    raw.emit('drain');
    await pending;
    expect(resolved).toBe(true);
  });
});

describe('withStreamIdleTimeout', () => {
  test('passes events through unchanged', async () => {
    async function* source() {
      yield 1;
      yield 2;
    }
    const seen: number[] = [];
    for await (const value of withStreamIdleTimeout(source(), 1000)) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  test('throws and aborts the upstream when it goes silent', async () => {
    let aborted = false;
    const stalled: any = {
      controller: { abort: () => (aborted = true) },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };

    await expect(
      (async () => {
        for await (const _ of withStreamIdleTimeout(stalled, 20)) {
          // no events expected
        }
      })()
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(aborted).toBe(true);
  });

  test('idle time is measured per event, not across the whole stream', async () => {
    async function* slow() {
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield i;
      }
    }
    const seen: number[] = [];
    for await (const value of withStreamIdleTimeout(slow(), 40)) seen.push(value);
    expect(seen).toEqual([0, 1, 2]);
  });
});
