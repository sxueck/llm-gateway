import { test, expect } from 'vitest';

import { VirtualKeyQueueService, virtualKeyQueueService } from './virtual-key-queue.js';

// ─── helpers ────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('acquire within concurrency limit grants immediately; release frees a slot', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 2 });

  const r1 = await svc.acquire('key-a');
  expect(r1.granted).toBe(true);
  expect(typeof (r1 as any).release).toBe('function');

  const r2 = await svc.acquire('key-a');
  expect(r2.granted).toBe(true);

  (r1 as any).release();

  const r3 = await svc.acquire('key-a');
  expect(r3.granted).toBe(true);

  (r2 as any).release();
  (r3 as any).release();
});

test('hitting maxConcurrency queues further acquires instead of granting immediately', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a');
  expect(r1.granted).toBe(true);

  const pending = svc.acquire('key-a');
  const race = await Promise.race([
    pending.then(() => 'acquired'),
    delay(80).then(() => 'timeout'),
  ]);
  expect(race).toBe('timeout');

  (r1 as any).release();
  const r2 = await pending;
  expect(r2.granted).toBe(true);
  (r2 as any).release();
});

test('queued requests are promoted in FIFO order', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a');

  let promotionOrder = 0;
  const p2 = svc.acquire('key-a').then((r) => {
    if (r.granted && promotionOrder === 0) promotionOrder = 1;
    return r;
  });
  const p3 = svc.acquire('key-a').then((r) => {
    if (r.granted && promotionOrder === 0) promotionOrder = 2;
    return r;
  });

  (r1 as any).release();
  const r2 = await p2;
  expect(r2.granted).toBe(true);
  expect(promotionOrder).toBe(1);

  (r2 as any).release();
  const r3 = await p3;
  expect(r3.granted).toBe(true);
  expect(promotionOrder).toBe(1);

  (r3 as any).release();
});

test('returns queue_full immediately when queue is at capacity', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1, maxQueueSize: 2 });

  const r1 = await svc.acquire('key-a');

  svc.acquire('key-a');
  svc.acquire('key-a');

  const result = await svc.acquire('key-a');
  expect(result.granted).toBe(false);
  if (!result.granted) {
    expect(result.reason).toBe('queue_full');
  }

  (r1 as any).release();
});

test('queued request times out after queueTimeoutMs', async () => {
  const timeoutMs = 80;
  const svc = new VirtualKeyQueueService({
    maxConcurrency: 1,
    queueTimeoutMs: timeoutMs,
  });

  const r1 = await svc.acquire('key-a');

  const startedAt = Date.now();
  const result = await svc.acquire('key-a');
  const elapsed = Date.now() - startedAt;

  expect(result.granted).toBe(false);
  if (!result.granted) {
    expect(result.reason).toBe('timeout');
  }
  expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);

  (r1 as any).release();
});

test('aborting the signal cancels a queued request with reason cancelled', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a');

  const ac = new AbortController();
  const pending = svc.acquire('key-a', ac.signal);

  await delay(10);
  ac.abort();

  const result = await pending;
  expect(result.granted).toBe(false);
  if (!result.granted) {
    expect(result.reason).toBe('cancelled');
  }

  (r1 as any).release();
});

test('release is idempotent — calling it multiple times is safe', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 2 });

  const r1 = await svc.acquire('key-a');
  expect(r1.granted).toBe(true);

  (r1 as any).release();
  (r1 as any).release();

  const r2 = await svc.acquire('key-a');
  const r3 = await svc.acquire('key-a');
  expect(r2.granted).toBe(true);
  expect(r3.granted).toBe(true);

  (r2 as any).release();
  (r3 as any).release();
});

test('different virtual keys get independent concurrency limits and queues', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const ra = await svc.acquire('key-a');
  const rb = await svc.acquire('key-b');
  expect(ra.granted).toBe(true);
  expect(rb.granted).toBe(true);

  const pa2 = svc.acquire('key-a');
  const raceA = await Promise.race([
    pa2.then(() => 'acquired'),
    delay(50).then(() => 'queued'),
  ]);
  expect(raceA).toBe('queued');

  (rb as any).release();
  const raceAfterB = await Promise.race([
    pa2.then(() => 'promoted-early'),
    delay(50).then(() => 'still-queued'),
  ]);
  expect(raceAfterB).toBe('still-queued');

  (ra as any).release();
  const ra2 = await pa2;
  expect(ra2.granted).toBe(true);

  (ra2 as any).release();
});

test('constructor accepts Partial<QueueConfig> to override defaults', async () => {
  const svc = new VirtualKeyQueueService({
    maxConcurrency: 3,
    maxQueueSize: 5,
    queueTimeoutMs: 100,
  });

  const granted: Promise<unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await svc.acquire('key');
    expect(r.granted).toBe(true);
    granted.push(Promise.resolve(r));
  }

  const pending = svc.acquire('key');
  const race = await Promise.race([
    pending.then(() => 'acquired'),
    delay(50).then(() => 'queued'),
  ]);
  expect(race).toBe('queued');

  const g0 = await granted[0];
  (g0 as any).release();

  const r4 = await pending;
  expect(r4.granted).toBe(true);

  for (let i = 1; i < granted.length; i++) {
    const r = await granted[i];
    (r as any).release();
  }
  (r4 as any).release();
});

test('singleton virtualKeyQueueService maintains shared state across references', async () => {
  const { virtualKeyQueueService: ref2 } = await import('./virtual-key-queue.js');

  expect(virtualKeyQueueService).toBeInstanceOf(VirtualKeyQueueService);
  expect(virtualKeyQueueService).toBe(ref2);

  const r1 = await virtualKeyQueueService.acquire('singleton-test-key');
  expect(r1.granted).toBe(true);

  (r1 as any).release();
});
