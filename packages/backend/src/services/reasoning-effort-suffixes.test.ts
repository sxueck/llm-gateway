import { test, expect } from 'vitest';

import {
  normalizeSuffixes,
  DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES,
} from './reasoning-effort-suffixes.js';

test('default suffixes include all spec values', () => {
  expect(DEFAULT_REASONING_EFFORT_MODEL_SUFFIXES).toEqual([
    'minimal',
    'low',
    'medium',
    'high',
    'none',
  ]);
});

test('normalizeSuffixes handles string array input', () => {
  expect(normalizeSuffixes(['low', 'medium', 'high'])).toEqual(['low', 'medium', 'high']);
});

test('normalizeSuffixes parses JSON string', () => {
  expect(normalizeSuffixes('["low","high"]')).toEqual(['low', 'high']);
});

test('normalizeSuffixes trims whitespace', () => {
  expect(normalizeSuffixes(['  low  ', 'high'])).toEqual(['low', 'high']);
});

test('normalizeSuffixes removes empty entries', () => {
  expect(normalizeSuffixes(['low', '', '  ', 'high'])).toEqual(['low', 'high']);
});

test('normalizeSuffixes deduplicates', () => {
  expect(normalizeSuffixes(['low', 'low', 'high'])).toEqual(['low', 'high']);
});

test('normalizeSuffixes filters non-string entries', () => {
  expect(normalizeSuffixes(['low', 42, true, null, 'high'] as any)).toEqual(['low', 'high']);
});

test('normalizeSuffixes handles invalid JSON gracefully', () => {
  expect(normalizeSuffixes('{invalid}')).toEqual([]);
});

test('normalizeSuffixes handles JSON non-array', () => {
  expect(normalizeSuffixes('{"a":1}')).toEqual([]);
});

test('normalizeSuffixes preserves empty array', () => {
  expect(normalizeSuffixes([])).toEqual([]);
  expect(normalizeSuffixes('[]')).toEqual([]);
});
