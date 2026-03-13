import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestCache } from './request-cache.js';

test('RequestCache destroy clears timer and cached entries', () => {
  const cache = new RequestCache(10, 60_000);
  cache.set('destroy-key', 'value', {});

  cache.destroy();

  assert.equal((cache as any).cleanupInterval, null);
  assert.equal(cache.getStats().size, 0);
  assert.equal(cache.get('destroy-key'), null);
});

test('RequestCache removes stale entry when oversize update cannot fit', () => {
  const cache = new RequestCache(10, 60_000);

  try {
    cache.set('same-key', 'small', {});
    const initialBytes = cache.getStats().totalBytes;

    (cache as any).maxBytes = initialBytes + 10;
    (cache as any).maxEntryBytes = 1_024;

    cache.set('same-key', 'x'.repeat(64), {});

    assert.equal(cache.get('same-key'), null);
    assert.equal(cache.getStats().size, 0);
    assert.equal(cache.getStats().totalBytes, 0);
  } finally {
    cache.destroy();
  }
});
