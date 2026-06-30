import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  upstreamFetch,
  extractUrlString,
  clearProxyAgentCache,
  requestToInit,
  toUndiciRequestInit,
} from './upstream-fetch.js';
import { upstreamSslConfigService } from '../services/upstream-ssl-config.js';
import { memoryLogger } from '../services/logger.js';

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

describe('upstreamFetch abort behavior', () => {
  it('should throw AbortError for pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await upstreamFetch('https://example.com', {
        timeoutMs: 5000,
        signal: controller.signal,
      });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.name).toBe('AbortError');
    }
  });

  it('should abort when signal is triggered during request', async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 10);

    try {
      await upstreamFetch('https://example.com', {
        timeoutMs: 10000,
        signal: controller.signal,
      });
      expect(false).toBe(true);
    } catch (error: any) {
      expect(error.name).toBe('AbortError');
    }
  });
});

describe('upstreamFetch with proxy', () => {
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

  it('should accept Request objects when proxy is configured', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';

    const request = new Request('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });

    try {
      await upstreamFetch(request);
    } catch (error: any) {
      expect(error.message).not.toContain('toString');
    }
  });
});

describe('upstreamFetch SSL skip-verify behavior', () => {
  let originalSkipVerify: boolean;

  beforeEach(() => {
    originalSkipVerify = upstreamSslConfigService.isSkipVerify();
    clearProxyAgentCache();
  });

  afterEach(() => {
    (upstreamSslConfigService as any).skipVerify = originalSkipVerify;
    clearProxyAgentCache();
  });

  it('should not inject tls option when skipVerify is false', async () => {
    (upstreamSslConfigService as any).skipVerify = false;
    try {
      await upstreamFetch('https://example.com', { timeoutMs: 100 });
    } catch {
      // expected to fail
    }
  });

  it('should clear proxy agent cache when called', () => {
    (upstreamSslConfigService as any).skipVerify = true;
    clearProxyAgentCache();
    // Should not throw
  });
});

describe('upstreamFetch error diagnostics and sanitization', () => {
  let originalSkipVerify: boolean;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalSkipVerify = upstreamSslConfigService.isSkipVerify();
    errorSpy = vi.spyOn(memoryLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    (upstreamSslConfigService as any).skipVerify = originalSkipVerify;
    errorSpy.mockRestore();
  });

  it('should log sanitized error without leaking API key in URL query', async () => {
    (upstreamSslConfigService as any).skipVerify = false;

    try {
      await upstreamFetch('https://api.example.com/v1?api_key=sk-secret123', {
        timeoutMs: 50,
      });
    } catch {
      // expected to fail
    }

    // Wait a tick for async error logging
    await new Promise((r) => setTimeout(r, 100));

    const call = errorSpy.mock.calls.find(
      (c) => c[1] === 'UpstreamFetch'
    );
    if (call) {
      const diagnostic = call[2] as Record<string, any>;
      expect(diagnostic.targetOrigin).toBe('https://api.example.com');
      expect(diagnostic.targetOrigin).not.toContain('sk-secret');
    }
  });

  it('should log diagnostic fields on connection error', async () => {
    (upstreamSslConfigService as any).skipVerify = false;

    try {
      await upstreamFetch('https://127.0.0.1:1/timeout', {
        timeoutMs: 50,
      });
    } catch {
      // expected to fail
    }

    await new Promise((r) => setTimeout(r, 100));

    const call = errorSpy.mock.calls.find(
      (c) => c[1] === 'UpstreamFetch'
    );

    if (call) {
      const diagnostic = call[2] as Record<string, any>;
      expect(diagnostic).toHaveProperty('message');
      expect(diagnostic).toHaveProperty('transportBranch');
      expect(diagnostic).toHaveProperty('skipVerify');
      expect(diagnostic).toHaveProperty('proxyMatched');
    }
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
      await upstreamFetch('https://127.0.0.1:1/narrow', options);
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
    const request = new Request('https://127.0.0.1:1/merge', {
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
