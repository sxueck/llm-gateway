import { describe, test, expect } from 'vitest';

import { detectPii, mightContainPii } from './pii-detector.js';

describe('pii-detector detection', () => {
  test('detects real high-precision secrets and PII', () => {
    expect(detectPii('use key sk-ABCDEFGHIJKLMNOPQRSTUVWX12345').some(d => d.type === 'secret')).toBe(true);
    expect(detectPii('Authorization: Bearer abcdefghijklmnopqrstuvwxyz12345').some(d => d.type === 'secret')).toBe(true);
    expect(detectPii('contact alice@example.com please').some(d => d.type === 'email')).toBe(true);
    expect(detectPii('server at 203.0.113.42 down').some(d => d.type === 'ip')).toBe(true);
  });

  // The model must not see corrupted code: ordinary high-entropy code tokens
  // (hashes, base64, UUIDs, long identifiers) must NOT be masked. We accept
  // missed detections (漏检) to protect coding quality.
  test('does not mask ordinary code tokens', () => {
    expect(detectPii('commit 9f2a4c1b8e7d6f5a4c3b2a1908f7e6d5c4b3a2f1 fixed')).toEqual([]);
    expect(detectPii('const X = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3OA==";')).toEqual([]);
    expect(detectPii('const someVeryLongCamelCaseIdentifierNameHere = 1;')).toEqual([]);
    expect(detectPii('id=550e8400-e29b-41d4-a716-446655440000')).toEqual([]);
  });
});

describe('pii-detector performance guards', () => {
  test('skips oversized fields (accepts 漏检 to protect CPU and quality)', () => {
    const huge = 'alice@example.com '.repeat(20000); // > 50k chars
    expect(mightContainPii(huge)).toBe(false);
    expect(detectPii(huge)).toEqual([]);
  });

  test('separator-heavy text does not cause catastrophic backtracking', () => {
    // Long hyphenated run (kebab-case / minified asset) followed by an email.
    // Previously this caused O(n^2) backtracking (multi-second freeze).
    const text = 'a-'.repeat(24000) + ' a@b.io';
    const start = performance.now();
    if (mightContainPii(text)) detectPii(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  test('bounds the number of matches per field', () => {
    const emails = Array.from({ length: 3000 }, (_, i) => `u${i}@e.io`).join(' ');
    const start = performance.now();
    const dets = detectPii(emails);
    const elapsed = performance.now() - start;
    expect(dets.length).toBeLessThanOrEqual(2000);
    expect(dets.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});
