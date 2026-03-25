import OpenAI from 'openai';
import { createHash } from 'node:crypto';

import { sanitizeCustomHeaders, getSanitizedHeadersCacheKey } from '../utils/header-sanitizer.js';
import {
  getProxyConfigFromEnv,
  getProxyUrlForTarget,
  isProxyConfigured,
} from '../utils/upstream-proxy.js';
import { createKeepAliveAgents, type KeepAliveAgents } from '../utils/proxy-agents.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';

import type { ProtocolConfig } from './protocol-adapter.js';

type LoggerLike = {
  debug: (message: string, tag?: string) => void;
};

const DEFAULT_MAX_CACHED_CLIENTS = 200;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_URL = 'default';
const DEFAULT_UPSTREAM_KEY = 'openai-default';
const KEEP_ALIVE_MSECS = 1_000;
const NO_HEADERS_CACHE_KEY = 'no-headers';

type CachedOpenAIClient = {
  client: OpenAI;
  upstreamKey: string;
};

type ResolvedClientConfig = {
  normalizedBaseUrl: string;
  upstreamKey: string;
  cacheKey: string;
  timeout: number;
  maxRetries: number;
  sanitizedHeaders?: Record<string, string>;
  proxyUrl: string | null;
};

/**
 * Create a custom fetch function that routes through upstreamFetch for proxy support.
 * This provides proxy support for the OpenAI SDK.
 *
 * IMPORTANT: This function preserves full Request semantics by passing the Request
 * object directly to upstreamFetch, which handles URL extraction and proxy routing.
 */
function createCustomFetch(): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Pass the full url (which may be a Request) to upstreamFetch
    // upstreamFetch handles Request objects properly, preserving method/body/headers
    return upstreamFetch(url, init ? { ...init } : {});
  };
}

export class HttpClientFactory {
  private openaiClients: Map<string, CachedOpenAIClient> = new Map();
  private keepAliveAgents: Map<string, KeepAliveAgents> = new Map();
  private proxyConfig = getProxyConfigFromEnv();
  private hasProxyConfigured = isProxyConfigured();

  constructor(
    private readonly options: {
      keepAliveMaxSockets: number;
      maxCachedClients?: number;
      logger?: LoggerLike;
    }
  ) {}

  private getMaxCachedClients(): number {
    const configured = this.options.maxCachedClients;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return DEFAULT_MAX_CACHED_CLIENTS;
  }

  private normalizeBaseUrl(baseUrl?: string): string {
    if (!baseUrl) {
      return DEFAULT_BASE_URL;
    }

    return baseUrl.replace(/\/+$/, '');
  }

  private getUpstreamKey(baseUrl?: string): string {
    const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
    if (normalizedBaseUrl === DEFAULT_BASE_URL) {
      return DEFAULT_UPSTREAM_KEY;
    }

    try {
      return new URL(normalizedBaseUrl).origin.toLowerCase();
    } catch {
      return normalizedBaseUrl.toLowerCase();
    }
  }

  private hashValue(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private buildClientCacheKey(input: {
    normalizedBaseUrl: string;
    apiKey: string;
    headersKey: string;
    timeout: number;
    maxRetries: number;
    proxyUrl: string | null;
  }): string {
    const apiKeyFingerprint = this.hashValue(input.apiKey || '');
    const timeoutPart = String(input.timeout);
    const retriesPart = String(input.maxRetries);
    const proxyPart = input.proxyUrl ? this.hashValue(input.proxyUrl) : 'no-proxy';

    return `${input.normalizedBaseUrl}|${apiKeyFingerprint}|${input.headersKey}|${timeoutPart}|${retriesPart}|${proxyPart}`;
  }

  private createKeepAliveAgents(): KeepAliveAgents {
    return createKeepAliveAgents({
      keepAliveMsecs: KEEP_ALIVE_MSECS,
      maxSockets: this.options.keepAliveMaxSockets,
    });
  }

  private getKeepAliveAgents(upstreamKey: string): KeepAliveAgents {
    if (!this.keepAliveAgents.has(upstreamKey)) {
      this.keepAliveAgents.set(upstreamKey, this.createKeepAliveAgents());
    }

    return this.keepAliveAgents.get(upstreamKey)!;
  }

  private getProxyUrlForBaseUrl(baseUrl: string): string | null {
    if (!this.hasProxyConfigured) {
      return null;
    }
    return getProxyUrlForTarget(baseUrl, this.proxyConfig);
  }

  private resolveClientConfig(config: ProtocolConfig): ResolvedClientConfig {
    const sanitizedHeaders = sanitizeCustomHeaders(config.modelAttributes?.headers);
    const normalizedBaseUrl = this.normalizeBaseUrl(config.baseUrl);
    const upstreamKey = this.getUpstreamKey(config.baseUrl);
    const timeout = config.modelAttributes?.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = config.modelAttributes?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const headersKey = getSanitizedHeadersCacheKey(sanitizedHeaders) || NO_HEADERS_CACHE_KEY;
    const proxyUrl = this.getProxyUrlForBaseUrl(normalizedBaseUrl === DEFAULT_BASE_URL ? 'https://api.openai.com' : normalizedBaseUrl);

    const cacheKey = this.buildClientCacheKey({
      normalizedBaseUrl,
      apiKey: config.apiKey,
      headersKey,
      timeout,
      maxRetries,
      proxyUrl,
    });

    return {
      normalizedBaseUrl,
      upstreamKey,
      cacheKey,
      timeout,
      maxRetries,
      sanitizedHeaders,
      proxyUrl,
    };
  }

  private getCachedClient(cacheKey: string): OpenAI | undefined {
    const cachedClient = this.openaiClients.get(cacheKey);
    if (!cachedClient) {
      return undefined;
    }

    // Keep insertion order fresh for LRU-style eviction.
    this.openaiClients.delete(cacheKey);
    this.openaiClients.set(cacheKey, cachedClient);
    return cachedClient.client;
  }

  private buildOpenAIClientConfig(
    config: ProtocolConfig,
    resolvedConfig: ResolvedClientConfig
  ): any {
    // Always use keep-alive agents for connection pooling
    const agents = this.getKeepAliveAgents(resolvedConfig.upstreamKey);

    const clientConfig: any = {
      apiKey: config.apiKey,
      maxRetries: resolvedConfig.maxRetries,
      timeout: resolvedConfig.timeout,
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
    };

    // Only use custom fetch when proxy is actually configured
    // This preserves original keep-alive behavior on the no-proxy path
    if (resolvedConfig.proxyUrl) {
      clientConfig.fetch = createCustomFetch();
    }

    if (resolvedConfig.normalizedBaseUrl !== DEFAULT_BASE_URL) {
      clientConfig.baseURL = resolvedConfig.normalizedBaseUrl;
    }

    if (resolvedConfig.sanitizedHeaders) {
      clientConfig.defaultHeaders = resolvedConfig.sanitizedHeaders;
      this.options.logger?.debug(
        `添加自定义请求头 | provider: ${config.provider} | headers: ${JSON.stringify(resolvedConfig.sanitizedHeaders)}`,
        'Protocol'
      );
    }

    return clientConfig;
  }

  private releaseUpstreamAgentsIfUnused(upstreamKey: string): void {
    for (const cached of this.openaiClients.values()) {
      if (cached.upstreamKey === upstreamKey) {
        return;
      }
    }

    const agents = this.keepAliveAgents.get(upstreamKey);
    if (agents) {
      agents.httpAgent.destroy();
      agents.httpsAgent.destroy();
      this.keepAliveAgents.delete(upstreamKey);
    }
  }

  private evictOldestClientIfNeeded(preserveUpstreamKey?: string): void {
    const maxCachedClients = this.getMaxCachedClients();

    while (this.openaiClients.size >= maxCachedClients) {
      const oldestKey = this.openaiClients.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }

      const oldestClient = this.openaiClients.get(oldestKey);
      this.openaiClients.delete(oldestKey);

      if (oldestClient && oldestClient.upstreamKey !== preserveUpstreamKey) {
        this.releaseUpstreamAgentsIfUnused(oldestClient.upstreamKey);
      }
    }
  }

  getOpenAIClient(config: ProtocolConfig): OpenAI {
    const resolvedConfig = this.resolveClientConfig(config);
    const cachedClient = this.getCachedClient(resolvedConfig.cacheKey);
    if (cachedClient) {
      return cachedClient;
    }

    this.evictOldestClientIfNeeded(resolvedConfig.upstreamKey);
    const clientConfig = this.buildOpenAIClientConfig(config, resolvedConfig);

    const client = new OpenAI(clientConfig);
    this.openaiClients.set(resolvedConfig.cacheKey, { client, upstreamKey: resolvedConfig.upstreamKey });
    this.options.logger?.debug(
      `创建 OpenAI 客户端 | baseUrl: ${resolvedConfig.normalizedBaseUrl} | upstream: ${resolvedConfig.upstreamKey} | maxRetries: ${resolvedConfig.maxRetries} | proxy: ${resolvedConfig.proxyUrl ? 'enabled' : 'disabled'}`,
      'Protocol'
    );

    return client;
  }
}
