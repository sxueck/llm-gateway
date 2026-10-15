import { test, expect, vi } from 'vitest';

import {
  CircuitBreaker,
  CircuitState,
  httpFailureError,
  isBreakerEligibleFailure,
} from './circuit-breaker.js';

test('isBreakerEligibleFailure counts only target-health statuses', () => {
  for (const status of [401, 403, 429, 472, 500, 502, 503, 504]) {
    expect(isBreakerEligibleFailure(status)).toBe(true);
  }
  for (const status of [400, 402, 404, 405, 409, 413, 422]) {
    expect(isBreakerEligibleFailure(status)).toBe(false);
  }
  expect(isBreakerEligibleFailure(undefined)).toBe(true);
  expect(isBreakerEligibleFailure(null)).toBe(true);
});

test('CircuitBreaker ignores client-error statuses and stays closed', () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    successThreshold: 1,
    timeout: 60_000,
    halfOpenMaxAttempts: 1,
  });

  breaker.recordFailure('provider-x', { statusCode: 400, message: 'bad request' });
  breaker.recordFailure('provider-x', { status: 404, message: 'not found' });
  breaker.recordFailure('provider-x', httpFailureError(422));

  expect(breaker.getState('provider-x')).toBe(CircuitState.CLOSED);
  expect(breaker.isAvailable('provider-x')).toBe(true);
});

test('CircuitBreaker releases HALF_OPEN probes after ignored client errors', () => {
  vi.useFakeTimers();
  try {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      timeout: 10_000,
      halfOpenMaxAttempts: 1,
    });
    const key = 'provider-half-open-client-error';
    breaker.recordFailure(key, httpFailureError(503));
    vi.advanceTimersByTime(10_000);

    for (const status of [400, 404, 422]) {
      expect(breaker.isAvailable(key)).toBe(true);
      breaker.recordFailure(key, httpFailureError(status));
      expect(breaker.getState(key)).toBe(CircuitState.HALF_OPEN);
      expect(breaker.peekAvailability(key)).toBe(true);
    }

    expect(breaker.isAvailable(key)).toBe(true);
    breaker.recordSuccess(key);
    expect(breaker.getState(key)).toBe(CircuitState.CLOSED);
  } finally {
    vi.useRealTimers();
  }
});

test('CircuitBreaker still counts retryable statuses and transport failures', () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    successThreshold: 1,
    timeout: 60_000,
    halfOpenMaxAttempts: 1,
  });

  breaker.recordFailure('provider-y', httpFailureError(429));
  breaker.recordFailure('provider-y', new Error('socket hang up'));

  expect(breaker.getState('provider-y')).toBe(CircuitState.OPEN);
});

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

test('CircuitBreaker keeps OPEN state unavailable during cooldown', () => {
  vi.useFakeTimers();
  try {
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

    vi.advanceTimersByTime(25);

    expect(breaker.getState(providerKey)).toBe(CircuitState.OPEN);
    expect(breaker.isAvailable(providerKey)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('CircuitBreaker limits HALF_OPEN attempts by halfOpenMaxAttempts after cooldown', () => {
  vi.useFakeTimers();
  try {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 1,
      halfOpenMaxAttempts: 2,
    });

    const providerKey = 'provider-half-open-limit';

    breaker.recordFailure(providerKey, new Error('upstream failed'));

    vi.advanceTimersByTime(1);

    expect(breaker.isAvailable(providerKey)).toBe(true);
    expect(breaker.isAvailable(providerKey)).toBe(true);
    expect(breaker.isAvailable(providerKey)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('CircuitBreaker closes when HALF_OPEN successes reach successThreshold', () => {
  vi.useFakeTimers();
  try {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 1,
      halfOpenMaxAttempts: 3,
    });

    const providerKey = 'provider-half-open-close';

    breaker.recordFailure(providerKey, new Error('upstream failed'));

    vi.advanceTimersByTime(1);

    expect(breaker.isAvailable(providerKey)).toBe(true);
    breaker.recordSuccess(providerKey);
    expect(breaker.getState(providerKey)).toBe(CircuitState.HALF_OPEN);

    expect(breaker.isAvailable(providerKey)).toBe(true);
    breaker.recordSuccess(providerKey);

    expect(breaker.getState(providerKey)).toBe(CircuitState.CLOSED);
    expect(breaker.isAvailable(providerKey)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('CircuitBreaker reopens when HALF_OPEN attempt fails', () => {
  vi.useFakeTimers();
  try {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 1,
      halfOpenMaxAttempts: 2,
    });

    const providerKey = 'provider-half-open-reopen';

    breaker.recordFailure(providerKey, new Error('upstream failed'));

    vi.advanceTimersByTime(1);

    expect(breaker.isAvailable(providerKey)).toBe(true);
    breaker.recordFailure(providerKey, new Error('half open failed'));

    expect(breaker.getState(providerKey)).toBe(CircuitState.OPEN);
    expect(breaker.isAvailable(providerKey)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('CircuitBreaker rejects halfOpenMaxAttempts < 1', () => {
  expect(() => new CircuitBreaker({ halfOpenMaxAttempts: 0 })).toThrow(
    /halfOpenMaxAttempts must be >= 1/
  );
  expect(() => new CircuitBreaker({ halfOpenMaxAttempts: -1 })).toThrow(
    /halfOpenMaxAttempts must be >= 1/
  );
});
