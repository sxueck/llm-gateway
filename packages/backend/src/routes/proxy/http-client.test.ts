import { test, expect } from 'vitest';

import { buildOpenAICompatibleUrl } from './http-client.js';

const urlCases: Array<[string | undefined, string, string]> = [
  ['https://api.openai.com', '/v1/images/generations', 'https://api.openai.com/v1/images/generations'],
  ['https://api.openai.com/v1', '/v1/images/generations', 'https://api.openai.com/v1/images/generations'],
  ['https://api.openai.com/v1/', '/v1/images/generations', 'https://api.openai.com/v1/images/generations'],
  ['https://api.openai.com/v1', 'images/generations', 'https://api.openai.com/v1/images/generations'],
  [undefined, '/v1/images/generations', '/v1/images/generations'],
  ['https://api.openai.com', '/images/generations', 'https://api.openai.com/images/generations'],
];

test('buildOpenAICompatibleUrl handles baseUrl/path combinations', () => {
  for (const [baseUrl, path, expected] of urlCases) {
    expect(buildOpenAICompatibleUrl(baseUrl, path)).toBe(expected);
  }
});

