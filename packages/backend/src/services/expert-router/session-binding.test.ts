import { describe, expect, test } from 'vitest';

import {
  ExpertRoutingSessionBindingStore,
  extractExpertRoutingSessionId,
} from './session-binding.js';

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
});

describe('ExpertRoutingSessionBindingStore', () => {
  test('binds categories per expert routing config, virtual key, and session', () => {
    const store = new ExpertRoutingSessionBindingStore();

    store.set('routing-a', 'vk-a', 'session-1', 'coding');
    store.set('routing-a', 'vk-b', 'session-1', 'writing');
    store.set('routing-b', 'vk-a', 'session-1', 'analysis');

    expect(store.get('routing-a', 'vk-a', 'session-1')).toBe('coding');
    expect(store.get('routing-a', 'vk-b', 'session-1')).toBe('writing');
    expect(store.get('routing-b', 'vk-a', 'session-1')).toBe('analysis');
  });

  test('evicts oldest bindings when capacity is exceeded', () => {
    const store = new ExpertRoutingSessionBindingStore(2);

    store.set('routing-a', 'vk-a', 'session-1', 'coding');
    store.set('routing-a', 'vk-a', 'session-2', 'writing');
    store.set('routing-a', 'vk-a', 'session-3', 'analysis');

    expect(store.get('routing-a', 'vk-a', 'session-1')).toBeUndefined();
    expect(store.get('routing-a', 'vk-a', 'session-2')).toBe('writing');
    expect(store.get('routing-a', 'vk-a', 'session-3')).toBe('analysis');
  });
});
