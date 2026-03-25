/**
 * Tests for upstream-proxy utilities.
 * Focus on env precedence, NO_PROXY matching, and passthrough behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  getProxyConfigFromEnv,
  isHostInNoProxy,
  getProxyUrlForTarget,
  isProxyConfigured,
} from './upstream-proxy.js';

describe('getProxyConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear proxy-related env vars before each test
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should read uppercase env vars', () => {
    process.env.HTTP_PROXY = 'http://proxy.example.com:8080';
    process.env.HTTPS_PROXY = 'https://proxy.example.com:8443';
    process.env.NO_PROXY = 'localhost,127.0.0.1';

    const config = getProxyConfigFromEnv();
    expect(config.httpProxyUrl).toBe('http://proxy.example.com:8080');
    expect(config.httpsProxyUrl).toBe('https://proxy.example.com:8443');
    expect(config.noProxy).toEqual(['localhost', '127.0.0.1']);
  });

  it('should fallback to lowercase env vars when uppercase not set', () => {
    process.env.http_proxy = 'http://lower-proxy.example.com:8080';
    process.env.https_proxy = 'https://lower-proxy.example.com:8443';
    process.env.no_proxy = 'local.internal';

    const config = getProxyConfigFromEnv();
    expect(config.httpProxyUrl).toBe('http://lower-proxy.example.com:8080');
    expect(config.httpsProxyUrl).toBe('https://lower-proxy.example.com:8443');
    expect(config.noProxy).toEqual(['local.internal']);
  });

  it('should prefer uppercase over lowercase env vars', () => {
    process.env.HTTP_PROXY = 'http://upper.example.com:8080';
    process.env.http_proxy = 'http://lower.example.com:9090';
    process.env.HTTPS_PROXY = 'https://upper.example.com:8443';
    process.env.https_proxy = 'https://lower.example.com:9443';
    process.env.NO_PROXY = 'api.upper.com';
    process.env.no_proxy = 'api.lower.com';

    const config = getProxyConfigFromEnv();
    expect(config.httpProxyUrl).toBe('http://upper.example.com:8080');
    expect(config.httpsProxyUrl).toBe('https://upper.example.com:8443');
    expect(config.noProxy).toEqual(['api.upper.com']);
  });

  it('should return null for missing proxy configs', () => {
    const config = getProxyConfigFromEnv();
    expect(config.httpProxyUrl).toBeNull();
    expect(config.httpsProxyUrl).toBeNull();
    expect(config.noProxy).toEqual([]);
  });

  it('should parse NO_PROXY with spaces correctly', () => {
    process.env.NO_PROXY = 'localhost, 127.0.0.1 , .example.com ,api.internal';

    const config = getProxyConfigFromEnv();
    expect(config.noProxy).toEqual(['localhost', '127.0.0.1', '.example.com', 'api.internal']);
  });
});

describe('isHostInNoProxy', () => {
  it('should return false for empty hostname or patterns', () => {
    expect(isHostInNoProxy('', ['localhost'])).toBe(false);
    expect(isHostInNoProxy('example.com', [])).toBe(false);
    expect(isHostInNoProxy('', [])).toBe(false);
  });

  it('should match exact hostname', () => {
    expect(isHostInNoProxy('localhost', ['localhost'])).toBe(true);
    expect(isHostInNoProxy('example.com', ['example.com'])).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isHostInNoProxy('LOCALHOST', ['localhost'])).toBe(true);
    expect(isHostInNoProxy('Example.COM', ['example.com'])).toBe(true);
    expect(isHostInNoProxy('localhost', ['LOCALHOST'])).toBe(true);
  });

  it('should match wildcard', () => {
    expect(isHostInNoProxy('any.host.com', ['*'])).toBe(true);
    expect(isHostInNoProxy('localhost', ['*'])).toBe(true);
  });

  it('should match domain suffix with leading dot', () => {
    const patterns = ['.example.com'];
    expect(isHostInNoProxy('api.example.com', patterns)).toBe(true);
    expect(isHostInNoProxy('sub.api.example.com', patterns)).toBe(true);
    expect(isHostInNoProxy('example.com', patterns)).toBe(true); // Also matches domain without subdomain
    expect(isHostInNoProxy('other.com', patterns)).toBe(false);
    expect(isHostInNoProxy('notexample.com', patterns)).toBe(false);
  });

  it('should match patterns without leading dot for exact and subdomain matches', () => {
    const patterns = ['example.com'];
    expect(isHostInNoProxy('example.com', patterns)).toBe(true);
    expect(isHostInNoProxy('api.example.com', patterns)).toBe(true);
    expect(isHostInNoProxy('sub.api.example.com', patterns)).toBe(true);
    expect(isHostInNoProxy('notexample.com', patterns)).toBe(false);
    expect(isHostInNoProxy('example.com.au', patterns)).toBe(false);
  });

  it('should handle multiple patterns', () => {
    const patterns = ['localhost', '127.0.0.1', '.internal.com'];
    expect(isHostInNoProxy('localhost', patterns)).toBe(true);
    expect(isHostInNoProxy('127.0.0.1', patterns)).toBe(true);
    expect(isHostInNoProxy('api.internal.com', patterns)).toBe(true);
    expect(isHostInNoProxy('example.com', patterns)).toBe(false);
  });

  it('should handle IP addresses correctly', () => {
    const patterns = ['192.168.1.1', '10.0.0.0/8'];
    expect(isHostInNoProxy('192.168.1.1', patterns)).toBe(true);
    expect(isHostInNoProxy('192.168.1.2', patterns)).toBe(false);
    // Note: CIDR notation like 10.0.0.0/8 is treated as literal string
    expect(isHostInNoProxy('10.0.0.1', patterns)).toBe(false);
  });
});

describe('getProxyUrlForTarget', () => {
  it('should return null for invalid URLs', () => {
    const config = { httpProxyUrl: 'http://proxy:8080', httpsProxyUrl: null, noProxy: [] };
    expect(getProxyUrlForTarget('not-a-url', config)).toBeNull();
  });

  it('should use HTTPS_PROXY for https URLs', () => {
    const config = {
      httpProxyUrl: 'http://http-proxy:8080',
      httpsProxyUrl: 'http://https-proxy:8443',
      noProxy: [],
    };
    expect(getProxyUrlForTarget('https://api.openai.com', config)).toBe('http://https-proxy:8443');
  });

  it('should use HTTP_PROXY for http URLs', () => {
    const config = {
      httpProxyUrl: 'http://http-proxy:8080',
      httpsProxyUrl: 'http://https-proxy:8443',
      noProxy: [],
    };
    expect(getProxyUrlForTarget('http://api.example.com', config)).toBe('http://http-proxy:8080');
  });

  it('should fallback to HTTP_PROXY when HTTPS_PROXY is not set', () => {
    const config = {
      httpProxyUrl: 'http://http-proxy:8080',
      httpsProxyUrl: null,
      noProxy: [],
    };
    expect(getProxyUrlForTarget('https://api.openai.com', config)).toBe('http://http-proxy:8080');
  });

  it('should return null when NO_PROXY matches', () => {
    const config = {
      httpProxyUrl: 'http://proxy:8080',
      httpsProxyUrl: 'http://proxy:8443',
      noProxy: ['localhost', '.internal.com'],
    };
    expect(getProxyUrlForTarget('https://localhost/some/path', config)).toBeNull();
    expect(getProxyUrlForTarget('https://api.internal.com', config)).toBeNull();
    expect(getProxyUrlForTarget('https://api.example.com', config)).toBe('http://proxy:8443');
  });

  it('should return null when no proxy is configured', () => {
    const config = { httpProxyUrl: null, httpsProxyUrl: null, noProxy: [] };
    expect(getProxyUrlForTarget('https://api.openai.com', config)).toBeNull();
  });
});

describe('isProxyConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return false when no proxy is configured', () => {
    expect(isProxyConfigured()).toBe(false);
  });

  it('should return true when HTTP_PROXY is set', () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    expect(isProxyConfigured()).toBe(true);
  });

  it('should return true when HTTPS_PROXY is set', () => {
    process.env.HTTPS_PROXY = 'http://proxy:8443';
    expect(isProxyConfigured()).toBe(true);
  });

  it('should return true when lowercase proxy is set', () => {
    process.env.http_proxy = 'http://proxy:8080';
    expect(isProxyConfigured()).toBe(true);
  });
});
