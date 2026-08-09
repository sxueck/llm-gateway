import { describe, expect, test } from 'vitest';

import { extractExpertRoutingSessionId } from './session-binding.js';

describe('extractExpertRoutingSessionId', () => {
  test('uses explicit session id from headers before body fields', () => {
    const sessionId = extractExpertRoutingSessionId({
      headers: { 'x-session-id': ' header-session ' },
      body: { session_id: 'body-session' },
    });

    expect(sessionId).toBe('header-session');
  });

  test('uses existing session affinity header convention', () => {
    const sessionId = extractExpertRoutingSessionId({
      headers: { 'x-session-affinity': ' affinity-session ' },
      body: { session_id: 'body-session' },
    });

    expect(sessionId).toBe('affinity-session');
  });

  test('falls back to body metadata session id', () => {
    const sessionId = extractExpertRoutingSessionId({
      headers: {},
      body: { metadata: { sessionId: 'metadata-session' } },
    });

    expect(sessionId).toBe('metadata-session');
  });

  test('ignores prompt cache keys', () => {
    const sessionId = extractExpertRoutingSessionId({
      headers: {},
      body: { prompt_cache_key: 'cache-key-only' },
    });

    expect(sessionId).toBeUndefined();
  });

  test('truncates overlong session ids to the VARCHAR(256) column width', () => {
    const sessionId = extractExpertRoutingSessionId({
      headers: { 'x-session-id': 'x'.repeat(300) },
    });

    expect(sessionId).toHaveLength(256);
  });
});

