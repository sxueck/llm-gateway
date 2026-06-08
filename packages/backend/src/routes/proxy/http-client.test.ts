import { test, expect } from 'vitest';

import { buildOpenAICompatibleUrl } from './http-client.js';

test('buildOpenAICompatibleUrl handles baseUrl without /v1 and path with /v1', () => {
  expect(
    buildOpenAICompatibleUrl('https://api.openai.com', '/v1/images/generations')
  ).toBe('https://api.openai.com/v1/images/generations');
});

test('buildOpenAICompatibleUrl deduplicates /v1 when both baseUrl and path contain it', () => {
  expect(
    buildOpenAICompatibleUrl('https://api.openai.com/v1', '/v1/images/generations')
  ).toBe('https://api.openai.com/v1/images/generations');
});

test('buildOpenAICompatibleUrl handles baseUrl with trailing slash', () => {
  expect(
    buildOpenAICompatibleUrl('https://api.openai.com/v1/', '/v1/images/generations')
  ).toBe('https://api.openai.com/v1/images/generations');
});

test('buildOpenAICompatibleUrl handles path without leading slash', () => {
  expect(
    buildOpenAICompatibleUrl('https://api.openai.com/v1', 'images/generations')
  ).toBe('https://api.openai.com/v1/images/generations');
});

test('buildOpenAICompatibleUrl handles empty baseUrl', () => {
  expect(
    buildOpenAICompatibleUrl(undefined, '/v1/images/generations')
  ).toBe('/v1/images/generations');
});

test('buildOpenAICompatibleUrl handles baseUrl without /v1 and path without /v1', () => {
  expect(
    buildOpenAICompatibleUrl('https://api.openai.com', '/images/generations')
  ).toBe('https://api.openai.com/images/generations');
});
