import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualKeyQueueService, virtualKeyQueueService } from './virtual-key-queue.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Returns the promise itself (not awaited) so it can be used in Promise.race.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('acquire within concurrency limit grants immediately; release frees a slot', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 2 });

  const r1 = await svc.acquire('key-a');
  assert.equal(r1.granted, true);
  assert.ok(typeof (r1 as any).release === 'function');

  const r2 = await svc.acquire('key-a');
  assert.equal(r2.granted, true);

  // release one slot — the key should be able to acquire again later
  (r1 as any).release();

  const r3 = await svc.acquire('key-a');
  assert.equal(r3.granted, true);

  (r2 as any).release();
  (r3 as any).release();
});

test('hitting maxConcurrency queues further acquires instead of granting immediately', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a');
  assert.equal(r1.granted, true);

  // second acquire should queue — it must NOT resolve within a short window
  const pending = svc.acquire('key-a');
  const race = await Promise.race([
    pending.then(() => 'acquired'),
    delay(80).then(() => 'timeout'),
  ]);
  assert.equal(race, 'timeout', 'queued acquire should not resolve while slot is held');

  // release the active slot; queued request should now be granted
  (r1 as any).release();
  const r2 = await pending;
  assert.equal(r2.granted, true);
  (r2 as any).release();
});

test('queued requests are promoted in FIFO order', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a'); // holds the only slot

  let promotionOrder = 0;
  const p2 = svc.acquire('key-a').then((r) => {
    if (r.granted && promotionOrder === 0) promotionOrder = 1;
    return r;
  });
  const p3 = svc.acquire('key-a').then((r) => {
    if (r.granted && promotionOrder === 0) promotionOrder = 2;
    return r;
  });

  // release active — first queued (p2) should be promoted
  (r1 as any).release();
  const r2 = await p2;
  assert.equal(r2.granted, true);
  assert.equal(promotionOrder, 1, 'first queued request should be promoted first');

  // release promoted — second queued (p3) should now get promoted
  (r2 as any).release();
  const r3 = await p3;
  assert.equal(r3.granted, true);
  assert.equal(promotionOrder, 1, 'order should not change — p3 was never reached before p2');

  (r3 as any).release();
});

test('returns queue_full immediately when queue is at capacity', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1, maxQueueSize: 2 });

  const r1 = await svc.acquire('key-a'); // active=1, queue=0

  // queue 2 waiters (fills queue to capacity)
  svc.acquire('key-a'); // waiter 1
  svc.acquire('key-a'); // waiter 2

  // next acquire should be rejected immediately
  const result = await svc.acquire('key-a');
  assert.equal(result.granted, false);
  if (!result.granted) {
    assert.equal(result.reason, 'queue_full');
  }

  (r1 as any).release();
});

test('queued request times out after queueTimeoutMs', async () => {
  const timeoutMs = 80;
  const svc = new VirtualKeyQueueService({
    maxConcurrency: 1,
    queueTimeoutMs: timeoutMs,
  });

  const r1 = await svc.acquire('key-a'); // holds the only slot

  const startedAt = Date.now();
  const result = await svc.acquire('key-a'); // queues and waits for timeout
  const elapsed = Date.now() - startedAt;

  assert.equal(result.granted, false);
  if (!result.granted) {
    assert.equal(result.reason, 'timeout');
  }
  // elapsed should be at least timeoutMs (allow small clock skew)
  assert.ok(elapsed >= timeoutMs - 5, `timeout should be ~${timeoutMs}ms, got ${elapsed}ms`);

  (r1 as any).release();
});

test('aborting the signal cancels a queued request with reason cancelled', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const r1 = await svc.acquire('key-a'); // holds the only slot

  const ac = new AbortController();
  const pending = svc.acquire('key-a', ac.signal);

  // abort after a short delay to ensure the waiter is registered
  await delay(10);
  ac.abort();

  const result = await pending;
  assert.equal(result.granted, false);
  if (!result.granted) {
    assert.equal(result.reason, 'cancelled');
  }

  (r1 as any).release();
});

test('release is idempotent — calling it multiple times is safe', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 2 });

  const r1 = await svc.acquire('key-a');
  assert.equal(r1.granted, true);

  // release twice
  (r1 as any).release();
  (r1 as any).release();

  // after releasing (once effectively), we should still be able to acquire
  // up to maxConcurrency (2) without errors
  const r2 = await svc.acquire('key-a');
  const r3 = await svc.acquire('key-a');
  assert.equal(r2.granted, true);
  assert.equal(r3.granted, true);

  (r2 as any).release();
  (r3 as any).release();
});

test('different virtual keys get independent concurrency limits and queues', async () => {
  const svc = new VirtualKeyQueueService({ maxConcurrency: 1 });

  const ra = await svc.acquire('key-a'); // takes key-a's only slot
  const rb = await svc.acquire('key-b'); // should ALSO be granted — different key
  assert.equal(ra.granted, true);
  assert.equal(rb.granted, true);

  // key-a is full; next acquire for key-a queues
  const pa2 = svc.acquire('key-a');
  const raceA = await Promise.race([
    pa2.then(() => 'acquired'),
    delay(50).then(() => 'queued'),
  ]);
  assert.equal(raceA, 'queued', 'key-a next acquire should queue because key-a is full');

  // releasing key-b should NOT promote key-a's queued waiter
  (rb as any).release();
  const raceAfterB = await Promise.race([
    pa2.then(() => 'promoted-early'),
    delay(50).then(() => 'still-queued'),
  ]);
  assert.equal(raceAfterB, 'still-queued', 'releasing key-b should not promote key-a waiter');

  // releasing key-a's active slot should promote key-a's queued waiter
  (ra as any).release();
  const ra2 = await pa2;
  assert.equal(ra2.granted, true);

  (ra2 as any).release();
});

test('constructor accepts Partial<QueueConfig> to override defaults', async () => {
  const svc = new VirtualKeyQueueService({
    maxConcurrency: 3,
    maxQueueSize: 5,
    queueTimeoutMs: 100,
  });

  // with maxConcurrency=3, three acquires should be granted immediately
  const granted: Promise<unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await svc.acquire('key');
    assert.equal(r.granted, true);
    granted.push(Promise.resolve(r));
  }

  // 4th acquire should queue (not rejected, since maxQueueSize=5)
  const pending = svc.acquire('key');
  const race = await Promise.race([
    pending.then(() => 'acquired'),
    delay(50).then(() => 'queued'),
  ]);
  assert.equal(race, 'queued', '4th acquire should queue with custom config');

  // release one slot so the queued request can be granted
  const g0 = await granted[0];
  (g0 as any).release();

  const r4 = await pending;
  assert.equal(r4.granted, true, 'queued request should be granted after a slot is released');

  // cleanup remaining slots
  for (let i = 1; i < granted.length; i++) {
    const r = await granted[i];
    (r as any).release();
  }
  (r4 as any).release();
});

test('singleton virtualKeyQueueService maintains shared state across references', async () => {
  // import gives the same reference (ESM module cache)
  const { virtualKeyQueueService: ref2 } = await import('./virtual-key-queue.js');

  assert.ok(virtualKeyQueueService instanceof VirtualKeyQueueService);
  assert.strictEqual(virtualKeyQueueService, ref2, 'singleton should be the same instance');

  // functional test: acquire and release on the singleton works
  const r1 = await virtualKeyQueueService.acquire('singleton-test-key');
  assert.equal(r1.granted, true, 'singleton should grant acquires');

  (r1 as any).release();
});
