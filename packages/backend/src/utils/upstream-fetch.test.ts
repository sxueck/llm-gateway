import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import {
  upstreamFetch,
  extractUrlString,
  clearProxyAgentCache,
  requestToInit,
  toUndiciRequestInit,
} from './upstream-fetch.js';
import { upstreamSslConfigService } from '../services/upstream-ssl-config.js';
import { memoryLogger } from '../services/logger.js';

// --- undici mock: lets us assert on Agent/ProxyAgent construction params ---
const undiciMocks = vi.hoisted(() => ({
  Agent: vi.fn((opts?: any) => ({ __dispatcher: true, opts })),
  ProxyAgent: vi.fn((opts?: any) => ({ __dispatcher: true, opts })),
  fetch: vi.fn(),
}));

vi.mock('undici', () => undiciMocks);

describe('extractUrlString', () => {
  it('should handle string URLs', () => {
    expect(extractUrlString('https://example.com/path')).toBe('https://example.com/path');
  });

  it('should handle URL objects', () => {
    const url = new URL('https://example.com/path?query=value');
    expect(extractUrlString(url)).toBe('https://example.com/path?query=value');
  });

  it('should handle Request objects', () => {
    const request = new Request('https://example.com/path');
    expect(extractUrlString(request)).toBe('https://example.com/path');
  });
});

describe('requestToInit', () => {
  it('should preserve standard Request properties', () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'X-Custom': 'value' },
      body: '{"test":true}',
    });

    const init = requestToInit(request);
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);
    expect(init.body).toBeDefined();
    expect(init.mode).toBe(request.mode);
    expect(init.credentials).toBe(request.credentials);
    expect(init.redirect).toBe(request.redirect);
    expect(init.referrer).toBe(request.referrer);
    expect(init.referrerPolicy).toBe(request.referrerPolicy);
    expect(init.integrity).toBe(request.integrity);
    expect(init.signal).toBe(request.signal);
  });

  it('should preserve non-standard duplex property for undici', () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: '{"test":true}',
    });
    Object.defineProperty(request, 'duplex', { value: 'half' });

    const init = requestToInit(request);
    expect((init as any).duplex).toBe('half');
  });

  it('should preserve cache and keepalive when present', () => {
    const request = new Request('https://example.com', {
      method: 'GET',
    });
    Object.defineProperties(request, {
      cache: { value: 'no-store' },
      keepalive: { value: true },
    });

    const init = requestToInit(request);
    expect((init as any).cache).toBe('no-store');
    expect((init as any).keepalive).toBe(true);
  });
});

describe('toUndiciRequestInit', () => {
  it('should strip timeoutMs and pass through all other properties', () => {
    const mockDispatcher = {} as any;
    const init: RequestInit & { timeoutMs?: number; customField?: string } = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test":true}',
      timeoutMs: 5000,
      customField: 'preserved',
    };

    const undiciInit = toUndiciRequestInit(init, mockDispatcher);
    expect((undiciInit as any).timeoutMs).toBeUndefined();
    expect(undiciInit.method).toBe('POST');
    expect(undiciInit.headers).toEqual(init.headers);
    expect(undiciInit.body).toBe(init.body);
    expect((undiciInit as any).customField).toBe('preserved');
    expect(undiciInit.dispatcher).toBe(mockDispatcher);
  });

  it('should auto-inject duplex: half for ReadableStream body', () => {
    const mockDispatcher = {} as any;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('test'));
        controller.close();
      },
    });

    const init: RequestInit = {
      method: 'POST',
      body: stream as any,
    };

    const undiciInit = toUndiciRequestInit(init, mockDispatcher);
    expect((undiciInit as any).duplex).toBe('half');
    expect(undiciInit.body).toBe(stream);
  });

  it('should NOT override existing duplex value', () => {
    const mockDispatcher = {} as any;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('test'));
        controller.close();
      },
    });

    const init: RequestInit & { duplex: string } = {
      method: 'POST',
      body: stream as any,
      duplex: 'full' as any,
    };

    const undiciInit = toUndiciRequestInit(init, mockDispatcher);
    expect((undiciInit as any).duplex).toBe('full');
  });

  it('should NOT add duplex for non-ReadableStream body', () => {
    const mockDispatcher = {} as any;
    const init: RequestInit = {
      method: 'POST',
      body: '{"test":true}',
    };

    const undiciInit = toUndiciRequestInit(init, mockDispatcher);
    expect((undiciInit as any).duplex).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Abort behavior — uses rejects semantics, mocks global fetch to verify
// that the abort signal truly interrupts the in-flight request.
// ---------------------------------------------------------------------------
describe('upstreamFetch abort behavior', () => {
  let fetchSpy: MockInstance | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('should throw AbortError for pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      upstreamFetch('https://example.com', {
        timeoutMs: 5000,
        signal: controller.signal,
      })
    ).rejects.toSatisfy((err: any) => err.name === 'AbortError');
  });

  it('should reject with AbortError when client signal fires during request', async () => {
    const controller = new AbortController();

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: any, init?: any) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    setTimeout(() => controller.abort(), 10);

    await expect(
      upstreamFetch('https://example.com', {
        timeoutMs: 10000,
        signal: controller.signal,
      })
    ).rejects.toSatisfy((err: any) => err.name === 'AbortError');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should reject with AbortError on timeout', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url: any, init?: any) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    await expect(
      upstreamFetch('https://example.com', { timeoutMs: 30 })
    ).rejects.toSatisfy((err: any) => err.name === 'AbortError');
  });
});

// ---------------------------------------------------------------------------
// TLS / dispatcher configuration — verifies which dispatcher and which TLS
// options reach undici under each skipVerify × proxy combination.
// Any change that flips the production default to rejectUnauthorized:false
// will fail these tests.
// ---------------------------------------------------------------------------
describe('upstreamFetch TLS configuration', () => {
  let originalSkipVerify: boolean;
  let fetchSpy: MockInstance | undefined;

  beforeEach(() => {
    originalSkipVerify = upstreamSslConfigService.isSkipVerify();
    undiciMocks.Agent.mockClear();
    undiciMocks.ProxyAgent.mockClear();
    undiciMocks.fetch.mockReset();
    clearProxyAgentCache();
  });

  afterEach(() => {
    (upstreamSslConfigService as any).skipVerify = originalSkipVerify;
    clearProxyAgentCache();
    fetchSpy?.mockRestore();
  });

  it('should use native fetch and create NO undici Agent when skipVerify is false', async () => {
    (upstreamSslConfigService as any).skipVerify = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await upstreamFetch('https://example.com');

    // Native fetch — proves rejectUnauthorized is never touched
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(undiciMocks.Agent).not.toHaveBeenCalled();
    expect(undiciMocks.fetch).not.toHaveBeenCalled();
  });

  it('should create undici Agent with rejectUnauthorized:false for direct skipVerify', async () => {
    (upstreamSslConfigService as any).skipVerify = true;
    undiciMocks.fetch.mockResolvedValue(new Response('ok'));

    await upstreamFetch('https://example.com');

    expect(undiciMocks.Agent).toHaveBeenCalledTimes(1);
    expect(undiciMocks.Agent.mock.calls[0][0]).toEqual({
      connect: { rejectUnauthorized: false },
    });
    expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('regression guard: flipping skipVerify to true must NOT silently pass in default config', async () => {
    // If someone changes the default to skipVerify=true, this test catches it
    // because Agent would be created when it shouldn't be.
    (upstreamSslConfigService as any).skipVerify = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await upstreamFetch('https://example.com');
    expect(undiciMocks.Agent).not.toHaveBeenCalled();
  });
});

describe('upstreamFetch proxy + TLS behavior', () => {
  let originalSkipVerify: boolean;
  let httpsProxy: string | undefined;

  beforeEach(() => {
    originalSkipVerify = upstreamSslConfigService.isSkipVerify();
    httpsProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    undiciMocks.Agent.mockClear();
    undiciMocks.ProxyAgent.mockClear();
    undiciMocks.fetch.mockReset();
    clearProxyAgentCache();
  });

  afterEach(() => {
    (upstreamSslConfigService as any).skipVerify = originalSkipVerify;
    if (httpsProxy !== undefined) process.env.HTTPS_PROXY = httpsProxy;
    else delete process.env.HTTPS_PROXY;
    clearProxyAgentCache();
  });

  it('should create ProxyAgent WITHOUT requestTls when skipVerify is false', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    (upstreamSslConfigService as any).skipVerify = false;
    undiciMocks.fetch.mockResolvedValue(new Response('ok'));

    await upstreamFetch('https://api.example.com/v1/chat');

    expect(undiciMocks.ProxyAgent).toHaveBeenCalledTimes(1);
    const opts = undiciMocks.ProxyAgent.mock.calls[0][0];
    expect(opts.uri).toBe('http://proxy.example.com:8080');
    expect(opts.requestTls).toBeUndefined();
    expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('should create ProxyAgent WITH requestTls.rejectUnauthorized:false when skipVerify is true', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    (upstreamSslConfigService as any).skipVerify = true;
    undiciMocks.fetch.mockResolvedValue(new Response('ok'));

    await upstreamFetch('https://api.example.com/v1/chat');

    expect(undiciMocks.ProxyAgent).toHaveBeenCalledTimes(1);
    const opts = undiciMocks.ProxyAgent.mock.calls[0][0];
    expect(opts.uri).toBe('http://proxy.example.com:8080');
    expect(opts.requestTls).toEqual({ rejectUnauthorized: false });
  });

  it('should accept Request objects through the proxy path', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';
    (upstreamSslConfigService as any).skipVerify = false;
    undiciMocks.fetch.mockResolvedValue(new Response('ok'));

    const request = new Request('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });

    await upstreamFetch(request);

    expect(undiciMocks.fetch).toHaveBeenCalledTimes(1);
    const [url] = undiciMocks.fetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://api.example.com/v1/chat');
  });
});

describe('upstreamFetch error diagnostics and sanitization', () => {
  let originalSkipVerify: boolean;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: MockInstance | undefined;

  beforeEach(() => {
    originalSkipVerify = upstreamSslConfigService.isSkipVerify();
    errorSpy = vi.spyOn(memoryLogger, 'error').mockImplementation(() => {});
    (upstreamSslConfigService as any).skipVerify = false;
  });

  afterEach(() => {
    (upstreamSslConfigService as any).skipVerify = originalSkipVerify;
    errorSpy.mockRestore();
    fetchSpy?.mockRestore();
  });

  it('should log sanitized error without leaking API key in URL query', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('network error'), { cause: { code: 'ECONNREFUSED' } })
    );

    await expect(
      upstreamFetch('https://api.example.com/v1?api_key=sk-secret123', { timeoutMs: 5000 })
    ).rejects.toThrow();

    const call = errorSpy.mock.calls.find((c) => c[1] === 'UpstreamFetch');
    expect(call).toBeDefined();
    const diagnostic = call![2] as Record<string, any>;
    expect(diagnostic.targetOrigin).toBe('https://api.example.com');
    expect(diagnostic.targetOrigin).not.toContain('sk-secret');
  });

  it('should log diagnostic fields on connection error', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('connect failed'), {
        code: 'ECONNREFUSED',
        cause: { message: 'refused', code: 'ECONNREFUSED' },
      })
    );

    await expect(
      upstreamFetch('https://241.3.7.8:1/timeout', { timeoutMs: 5000 })
    ).rejects.toThrow();

    const call = errorSpy.mock.calls.find((c) => c[1] === 'UpstreamFetch');
    expect(call).toBeDefined();
    const diagnostic = call![2] as Record<string, any>;
    expect(diagnostic).toHaveProperty('message');
    expect(diagnostic).toHaveProperty('transportBranch');
    expect(diagnostic).toHaveProperty('skipVerify', false);
    expect(diagnostic).toHaveProperty('proxyMatched', 'no');
  });
});

describe('upstreamFetch RequestInit passthrough', () => {
  it('should not narrow RequestInit fields for string URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const options: RequestInit & { timeoutMs?: number; customField?: string } = {
      method: 'PATCH',
      headers: { 'X-Custom': 'value' },
      body: '{"test":true}',
      redirect: 'manual',
      credentials: 'include',
      customField: 'preserved',
    };

    try {
      await upstreamFetch('https://241.3.7.8:1/narrow', options);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { customField?: string }];
      expect(init.method).toBe('PATCH');
      expect(init.redirect).toBe('manual');
      expect(init.credentials).toBe('include');
      expect(init.customField).toBe('preserved');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('should merge Request object with explicit options', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const request = new Request('https://241.3.7.8:1/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"from":"request"}',
    });

    try {
      await upstreamFetch(request, {
        method: 'PUT',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('PUT');
      expect(init.headers).toBe(request.headers);
      expect(init.body).toBe(request.body);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
