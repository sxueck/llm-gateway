import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { upstreamFetch, extractUrlString } from './upstream-fetch.js';

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
