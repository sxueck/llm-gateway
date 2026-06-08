import { test, expect } from 'vitest';

import { RequestCache } from './request-cache.js';

test('RequestCache destroy clears timer and cached entries', () => {
  const cache = new RequestCache(10, 60_000);
  cache.set('destroy-key', 'value', {});

  cache.destroy();

  expect((cache as any).cleanupInterval).toBeNull();
  expect(cache.getStats().size).toBe(0);
  expect(cache.get('destroy-key')).toBeNull();
});

test('RequestCache removes stale entry when oversize update cannot fit', () => {
  const cache = new RequestCache(10, 60_000);

  try {
    cache.set('same-key', 'small', {});
    const initialBytes = cache.getStats().totalBytes;

    (cache as any).maxBytes = initialBytes + 10;
    (cache as any).maxEntryBytes = 1_024;

    cache.set('same-key', 'x'.repeat(64), {});

    expect(cache.get('same-key')).toBeNull();
    expect(cache.getStats().size).toBe(0);
    expect(cache.getStats().totalBytes).toBe(0);
  } finally {
    cache.destroy();
  }
});

test('RequestCache returns isolated response copies on cache hits', () => {
  const cache = new RequestCache(10, 60_000);

  try {
    cache.set('json-key', {
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'ok', instructions: 'debug' } }],
    }, { 'content-type': 'application/json' });

    const firstHit = cache.get('json-key');
    expect(firstHit).toBeTruthy();
    delete firstHit!.response.choices[0].message.instructions;
    firstHit!.headers['content-type'] = 'text/plain';

    const secondHit = cache.get('json-key');
    expect(secondHit).toBeTruthy();
    expect(secondHit!.response.choices[0].message.instructions).toBe('debug');
    expect(secondHit!.headers['content-type']).toBe('application/json');
  } finally {
    cache.destroy();
  }
});
