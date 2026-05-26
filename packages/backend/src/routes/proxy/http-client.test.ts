import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAICompatibleUrl } from './http-client.js';

test('buildOpenAICompatibleUrl handles baseUrl without /v1 and path with /v1', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://api.openai.com', '/v1/images/generations'),
    'https://api.openai.com/v1/images/generations'
  );
});

test('buildOpenAICompatibleUrl deduplicates /v1 when both baseUrl and path contain it', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://api.openai.com/v1', '/v1/images/generations'),
    'https://api.openai.com/v1/images/generations'
  );
});

test('buildOpenAICompatibleUrl handles baseUrl with trailing slash', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://api.openai.com/v1/', '/v1/images/generations'),
    'https://api.openai.com/v1/images/generations'
  );
});

test('buildOpenAICompatibleUrl handles path without leading slash', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://api.openai.com/v1', 'images/generations'),
    'https://api.openai.com/v1/images/generations'
  );
});

test('buildOpenAICompatibleUrl handles empty baseUrl', () => {
  assert.equal(
    buildOpenAICompatibleUrl(undefined, '/v1/images/generations'),
    '/v1/images/generations'
  );
});

test('buildOpenAICompatibleUrl handles baseUrl without /v1 and path without /v1', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://api.openai.com', '/images/generations'),
    'https://api.openai.com/images/generations'
  );
});
