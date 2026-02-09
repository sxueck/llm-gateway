import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpClientFactory } from './http-client-factory.js';

import type { ProtocolConfig } from './protocol-adapter.js';

function createConfig(overrides: Partial<ProtocolConfig> = {}): ProtocolConfig {
  return {
    provider: 'openai',
    apiKey: 'sk-default',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

test('HttpClientFactory reuses client for equivalent config', () => {
  const factory = new HttpClientFactory({
    keepAliveMaxSockets: 8,
    maxCachedClients: 4,
  });

  const first = factory.getOpenAIClient(
    createConfig({
      baseUrl: 'https://api.example.com/v1/',
      modelAttributes: {
        timeout: 5_000,
        maxRetries: 1,
        headers: {
          'X-Trace-B': '2',
          'X-Trace-A': '1',
        },
      },
    })
  );

  const second = factory.getOpenAIClient(
    createConfig({
      baseUrl: 'https://api.example.com/v1',
      modelAttributes: {
        timeout: 5_000,
        maxRetries: 1,
        headers: {
          'X-Trace-A': '1',
          'X-Trace-B': '2',
        },
      },
    })
  );

  assert.equal(second, first);
  assert.equal((factory as any).openaiClients.size, 1);
});

test('HttpClientFactory keeps most recently used client during eviction', () => {
  const factory = new HttpClientFactory({
    keepAliveMaxSockets: 8,
    maxCachedClients: 2,
  });

  const clientA = factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' }));
  const clientB = factory.getOpenAIClient(createConfig({ apiKey: 'sk-b' }));

  assert.equal(factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' })), clientA);

  factory.getOpenAIClient(createConfig({ apiKey: 'sk-c' }));

  assert.equal(factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' })), clientA);
  assert.notEqual(factory.getOpenAIClient(createConfig({ apiKey: 'sk-b' })), clientB);
});

test('HttpClientFactory releases old upstream keep-alive agents after eviction', () => {
  const factory = new HttpClientFactory({
    keepAliveMaxSockets: 8,
    maxCachedClients: 1,
  });

  factory.getOpenAIClient(
    createConfig({
      apiKey: 'sk-a',
      baseUrl: 'https://upstream-a.example.com/v1',
    })
  );

  factory.getOpenAIClient(
    createConfig({
      apiKey: 'sk-b',
      baseUrl: 'https://upstream-b.example.com/v1',
    })
  );

  const keepAliveAgents = (factory as any).keepAliveAgents as Map<string, unknown>;
  assert.equal(keepAliveAgents.size, 1);
  assert.ok(keepAliveAgents.has('https://upstream-b.example.com'));
});
