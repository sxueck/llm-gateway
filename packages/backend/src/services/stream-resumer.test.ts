import { test, describe, expect, vi } from 'vitest';

// Keep the resume helper import side-effect free in tests (no real DB pool).
vi.mock('../db/index.js', () => ({
  systemConfigDb: { get: vi.fn(async () => undefined) },
}));

import { RateLimitError, InternalServerError } from 'openai';

import {
  STREAM_RESUME_INSTRUCTION,
  buildResumeMessages,
  buildResumeResponsesParams,
  extractResumeRetryAfterMs,
  isRetryableResumeError,
  parseRetryAfterMs,
} from './stream-resumer.js';

describe('parseRetryAfterMs', () => {
  test('parses delay-seconds, including decimals like the OpenAI SDK', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('1.5')).toBe(1500);
    expect(parseRetryAfterMs(' 3 ')).toBe(3000);
  });

  test('parses HTTP-date values relative to now', () => {
    // toUTCString 只有秒级精度，基准时间取整到秒以避免毫秒截断噪音。
    const now = Math.floor(Date.now() / 1000) * 1000;
    const ms = parseRetryAfterMs(new Date(now + 3000).toUTCString(), now);
    expect(ms).toBeGreaterThanOrEqual(2999);
    expect(ms).toBeLessThanOrEqual(3100);
  });

  test('absent, invalid and negative values yield undefined; elapsed delays are zero', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    const now = Date.now();
    expect(parseRetryAfterMs(new Date(now - 5000).toUTCString(), now)).toBe(0);
  });
});

describe('extractResumeRetryAfterMs', () => {
  test('reads retry-after off a real OpenAI SDK RateLimitError', () => {
    // 可获得性验证：openai SDK APIError.headers 就是 fetch Headers 实例。
    const error = new RateLimitError(
      429,
      { message: 'Rate limit reached' },
      undefined,
      new Headers({ 'retry-after': '2' })
    );
    expect(extractResumeRetryAfterMs(error)).toBe(2000);
  });

  test('prefers retry-after-ms over retry-after', () => {
    const error = new RateLimitError(
      429,
      { message: 'Rate limit reached' },
      undefined,
      new Headers({ 'retry-after': '9', 'retry-after-ms': '250' })
    );
    expect(extractResumeRetryAfterMs(error)).toBe(250);
  });

  test('preserves server-advised waits beyond the resume window', () => {
    const error = new RateLimitError(
      429,
      { message: 'Rate limit reached' },
      undefined,
      new Headers({ 'retry-after': '120' })
    );
    expect(extractResumeRetryAfterMs(error)).toBe(120000);
  });

  test('tolerates plain-object headers and invalid retry-after-ms', () => {
    expect(extractResumeRetryAfterMs({ headers: { 'Retry-After': '3' } })).toBe(3000);
    // 无效的 retry-after-ms 应回退到 retry-after，而不是编造值。
    expect(
      extractResumeRetryAfterMs({
        headers: new Headers({ 'retry-after-ms': 'soon', 'retry-after': '4' }),
      })
    ).toBe(4000);
  });

  test('returns undefined when no usable header exists (no fabrication)', () => {
    expect(extractResumeRetryAfterMs(undefined)).toBeUndefined();
    expect(extractResumeRetryAfterMs(null)).toBeUndefined();
    expect(extractResumeRetryAfterMs(new Error('no headers'))).toBeUndefined();
    expect(
      extractResumeRetryAfterMs(
        new InternalServerError(500, { message: 'boom' }, undefined, new Headers())
      )
    ).toBeUndefined();
  });
});

describe('isRetryableResumeError', () => {
  test('retries transient statuses exactly like the SDK shouldRetry', () => {
    expect(isRetryableResumeError({ status: 408 })).toBe(true);
    expect(isRetryableResumeError({ status: 409 })).toBe(true);
    expect(isRetryableResumeError({ status: 429 })).toBe(true);
    expect(isRetryableResumeError({ status: 500 })).toBe(true);
    expect(isRetryableResumeError({ status: 503 })).toBe(true);
    expect(isRetryableResumeError({ status: 400 })).toBe(false);
    expect(isRetryableResumeError({ status: 401 })).toBe(false);
    expect(isRetryableResumeError({ status: 404 })).toBe(false);
  });

  test('honors x-should-retry and connection-level SDK errors', () => {
    expect(
      isRetryableResumeError({ headers: new Headers({ 'x-should-retry': 'true' }) })
    ).toBe(true);
    expect(
      isRetryableResumeError({ status: 400, headers: new Headers({ 'x-should-retry': 'false' }) })
    ).toBe(false);
    expect(isRetryableResumeError({ name: 'APIConnectionError' })).toBe(true);
    expect(isRetryableResumeError({ name: 'APIConnectionTimeoutError' })).toBe(true);
    expect(isRetryableResumeError(new Error('plain'))).toBe(false);
    expect(isRetryableResumeError(null)).toBe(false);
  });

  test('a real SDK RateLimitError with Retry-After is retryable', () => {
    const error = new RateLimitError(
      429,
      { message: 'Rate limit reached' },
      undefined,
      new Headers({ 'retry-after': '1' })
    );
    expect(isRetryableResumeError(error)).toBe(true);
  });
});

test('Responses continuation removes all tool configuration', () => {
  const result = buildResumeResponsesParams({
    model: 'test', input: 'hello', tools: [{}], mcp: {}, tool_search: {},
    parallel_tool_calls: true, max_tool_calls: 1,
  }, 'partial');
  for (const key of ['tools', 'mcp', 'tool_search', 'parallel_tool_calls', 'max_tool_calls']) {
    expect(result[key]).toBeUndefined();
  }
  expect(result.tool_choice).toBe('none');
});

describe('buildResumeMessages', () => {
  test('appends the partial assistant text and the continue instruction', () => {
    const original = [{ role: 'user', content: 'hi' }];
    const messages = buildResumeMessages(original, 'Hel');

    expect(messages).toHaveLength(3);
    expect(messages[0]).toBe(original[0]);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hel' });
    expect(messages[2]).toEqual({ role: 'user', content: STREAM_RESUME_INSTRUCTION });
  });
});
