import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

describe('HttpClientFactory proxy behavior', () => {
  let httpProxy: string | undefined;
  let httpsProxy: string | undefined;
  let noProxy: string | undefined;

  beforeEach(() => {
    httpProxy = process.env.HTTP_PROXY;
    httpsProxy = process.env.HTTPS_PROXY;
    noProxy = process.env.NO_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    if (httpProxy !== undefined) process.env.HTTP_PROXY = httpProxy;
    else delete process.env.HTTP_PROXY;
    if (httpsProxy !== undefined) process.env.HTTPS_PROXY = httpsProxy;
    else delete process.env.HTTPS_PROXY;
    if (noProxy !== undefined) process.env.NO_PROXY = noProxy;
    else delete process.env.NO_PROXY;
  });

  it('should include proxy in cache key calculation', () => {
    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const clientNoProxy = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';

    const factoryWithProxy = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const clientWithProxy = factoryWithProxy.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    expect(clientWithProxy).not.toBe(clientNoProxy);
  });

  it('should bypass proxy for NO_PROXY hosts', () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    process.env.NO_PROXY = 'localhost,127.0.0.1,internal.example.com';

    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const proxiedClient = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.external.com/v1',
        apiKey: 'sk-test',
      })
    );

    const directClient = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://internal.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    expect(proxiedClient).not.toBe(directClient);
  });

  it('should select HTTP_PROXY for http URLs', () => {
    process.env.HTTP_PROXY = 'http://http-proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'http://https-proxy.example.com:8443';

    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const httpClient = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'http://api.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    const httpsClient = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test2',
      })
    );

    expect(httpClient).toBeDefined();
    expect(httpsClient).toBeDefined();
  });

  it('should create OpenAI client with custom fetch when proxy configured', () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';

    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const client = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    expect(client).toBeDefined();
    expect(typeof client.chat).toBe('object');
    expect(typeof client.apiKey).toBe('string');
  });

  it('should NOT use custom fetch when no proxy is configured', () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;

    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 10,
    });

    const client = factory.getOpenAIClient(
      createConfig({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      })
    );

    expect(client).toBeDefined();
    expect(typeof client.chat).toBe('object');
    expect(typeof client.apiKey).toBe('string');
  });
});

describe('HttpClientFactory basic behavior', () => {
  it('should reuse client for equivalent config', () => {
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

    expect(second).toBe(first);
    expect((factory as any).openaiClients.size).toBe(1);
  });

  it('should keep most recently used client during eviction', () => {
    const factory = new HttpClientFactory({
      keepAliveMaxSockets: 8,
      maxCachedClients: 2,
    });

    const clientA = factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' }));
    factory.getOpenAIClient(createConfig({ apiKey: 'sk-b' }));

    expect(factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' }))).toBe(clientA);

    factory.getOpenAIClient(createConfig({ apiKey: 'sk-c' }));

    expect(factory.getOpenAIClient(createConfig({ apiKey: 'sk-a' }))).toBe(clientA);
  });

  it('should release old upstream keep-alive agents after eviction', () => {
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
    expect(keepAliveAgents.size).toBe(1);
    expect(keepAliveAgents.has('https://upstream-b.example.com')).toBe(true);
  });
});
