import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from './circuit-breaker.js';

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
