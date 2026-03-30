import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker, CircuitState } from './circuit-breaker.js';

test('CircuitBreaker isolates different model scopes under same provider', () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 1,
    timeout: 60_000,
    halfOpenMaxAttempts: 1,
  });

  const modelAcKey = 'provider-a::ac';
  const modelAdKey = 'provider-a::ad';

  breaker.recordFailure(modelAcKey, new Error('upstream failed'));

  assert.equal(breaker.isAvailable(modelAcKey), false);
  assert.equal(breaker.isAvailable(modelAdKey), true);
});

test('CircuitBreaker keeps provider-level key behavior unchanged', () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 1,
    timeout: 60_000,
    halfOpenMaxAttempts: 1,
  });

  const providerKey = 'provider-a';

  breaker.recordFailure(providerKey, new Error('upstream failed'));

  assert.equal(breaker.isAvailable(providerKey), false);
});

test('CircuitBreaker keeps OPEN state unavailable during cooldown', async () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 1,
    timeout: 50,
    halfOpenMaxAttempts: 1,
  });

  const providerKey = 'provider-cooldown';

  breaker.recordFailure(providerKey, new Error('upstream failed'));

  assert.equal(breaker.getState(providerKey), CircuitState.OPEN);
  assert.equal(breaker.isAvailable(providerKey), false);

  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(breaker.getState(providerKey), CircuitState.OPEN);
});

test('CircuitBreaker limits HALF_OPEN attempts by halfOpenMaxAttempts after cooldown', async () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    timeout: 1,
    halfOpenMaxAttempts: 2,
  });

  const providerKey = 'provider-half-open-limit';

  breaker.recordFailure(providerKey, new Error('upstream failed'));

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(breaker.isAvailable(providerKey), true);
  assert.equal(breaker.isAvailable(providerKey), true);
  assert.equal(breaker.isAvailable(providerKey), false);
});

test('CircuitBreaker closes when HALF_OPEN successes reach successThreshold', async () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    timeout: 1,
    halfOpenMaxAttempts: 3,
  });

  const providerKey = 'provider-half-open-close';

  breaker.recordFailure(providerKey, new Error('upstream failed'));

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(breaker.isAvailable(providerKey), true);
  breaker.recordSuccess(providerKey);
  assert.equal(breaker.getState(providerKey), CircuitState.HALF_OPEN);

  assert.equal(breaker.isAvailable(providerKey), true);
  breaker.recordSuccess(providerKey);

  assert.equal(breaker.getState(providerKey), CircuitState.CLOSED);
  assert.equal(breaker.isAvailable(providerKey), true);
});

test('CircuitBreaker reopens when HALF_OPEN attempt fails', async () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 2,
    timeout: 1,
    halfOpenMaxAttempts: 2,
  });

  const providerKey = 'provider-half-open-reopen';

  breaker.recordFailure(providerKey, new Error('upstream failed'));

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(breaker.isAvailable(providerKey), true);
  breaker.recordFailure(providerKey, new Error('half open failed'));

  assert.equal(breaker.getState(providerKey), CircuitState.OPEN);
  assert.equal(breaker.isAvailable(providerKey), false);
});

test('CircuitBreaker rejects halfOpenMaxAttempts < 1', () => {
  assert.throws(
    () => new CircuitBreaker({ halfOpenMaxAttempts: 0 }),
    /halfOpenMaxAttempts must be >= 1/
  );
  assert.throws(
    () => new CircuitBreaker({ halfOpenMaxAttempts: -1 }),
    /halfOpenMaxAttempts must be >= 1/
  );
});
