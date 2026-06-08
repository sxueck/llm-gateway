import { test, expect } from 'vitest';

import { CircuitBreaker, CircuitState } from './circuit-breaker.js';

test('CircuitBreaker defaults cooldown timeout to 10 seconds', () => {
  const breaker = new CircuitBreaker();

  expect((breaker as any).config.timeout).toBe(10_000);
});

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

  expect(breaker.isAvailable(modelAcKey)).toBe(false);
  expect(breaker.isAvailable(modelAdKey)).toBe(true);
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

  expect(breaker.isAvailable(providerKey)).toBe(false);
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

  expect(breaker.getState(providerKey)).toBe(CircuitState.OPEN);
  expect(breaker.isAvailable(providerKey)).toBe(false);

  await new Promise(resolve => setTimeout(resolve, 25));

  expect(breaker.getState(providerKey)).toBe(CircuitState.OPEN);
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

  expect(breaker.isAvailable(providerKey)).toBe(true);
  expect(breaker.isAvailable(providerKey)).toBe(true);
  expect(breaker.isAvailable(providerKey)).toBe(false);
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

  expect(breaker.isAvailable(providerKey)).toBe(true);
  breaker.recordSuccess(providerKey);
  expect(breaker.getState(providerKey)).toBe(CircuitState.HALF_OPEN);

  expect(breaker.isAvailable(providerKey)).toBe(true);
  breaker.recordSuccess(providerKey);

  expect(breaker.getState(providerKey)).toBe(CircuitState.CLOSED);
  expect(breaker.isAvailable(providerKey)).toBe(true);
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

  expect(breaker.isAvailable(providerKey)).toBe(true);
  breaker.recordFailure(providerKey, new Error('half open failed'));

  expect(breaker.getState(providerKey)).toBe(CircuitState.OPEN);
  expect(breaker.isAvailable(providerKey)).toBe(false);
});

test('CircuitBreaker rejects halfOpenMaxAttempts < 1', () => {
  expect(() => new CircuitBreaker({ halfOpenMaxAttempts: 0 })).toThrow(
    /halfOpenMaxAttempts must be >= 1/
  );
  expect(() => new CircuitBreaker({ halfOpenMaxAttempts: -1 })).toThrow(
    /halfOpenMaxAttempts must be >= 1/
  );
});
