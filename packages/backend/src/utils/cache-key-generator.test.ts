import { expect, test } from 'vitest';

import { generateCacheKey } from './cache-key-generator.js';

test('generates distinct keys for different reasoning efforts', () => {
  const baseRequest = {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'Explain this' }],
  };

  const lowKey = generateCacheKey({ ...baseRequest, reasoning_effort: 'low' }, 'vk-1');
  const highKey = generateCacheKey({ ...baseRequest, reasoning_effort: 'high' }, 'vk-1');

  expect(lowKey).not.toBe(highKey);
});
