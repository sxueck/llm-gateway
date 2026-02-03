import OpenAI from 'openai';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { sanitizeCustomHeaders, getSanitizedHeadersCacheKey } from '../utils/header-sanitizer.js';

import type { ProtocolConfig } from './protocol-adapter.js';

type LoggerLike = {
  debug: (message: string, tag?: string) => void;
};

export class HttpClientFactory {
  private openaiClients: Map<string, OpenAI> = new Map();
  private keepAliveAgents: Map<string, { httpAgent: HttpAgent; httpsAgent: HttpsAgent }> = new Map();

  constructor(
    private readonly options: {
      keepAliveMaxSockets: number;
      logger?: LoggerLike;
    }
  ) {}

  private getKeepAliveAgents(cacheKey: string): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
    if (!this.keepAliveAgents.has(cacheKey)) {
      const httpAgent = new HttpAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: this.options.keepAliveMaxSockets,
      });
      const httpsAgent = new HttpsAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: this.options.keepAliveMaxSockets,
      });
      this.keepAliveAgents.set(cacheKey, { httpAgent, httpsAgent });
    }

    return this.keepAliveAgents.get(cacheKey)!;
  }

  getOpenAIClient(config: ProtocolConfig): OpenAI {
    const sanitizedHeaders = sanitizeCustomHeaders(config.modelAttributes?.headers);
    // Use stable headers key generation to avoid cache busting on different key orders.
    const headersKey = getSanitizedHeadersCacheKey(sanitizedHeaders);
    const cacheKey = headersKey
      ? `${config.provider}-${config.baseUrl || 'default'}-${headersKey}`
      : `${config.provider}-${config.baseUrl || 'default'}`;

    if (!this.openaiClients.has(cacheKey)) {
      const clientConfig: any = {
        apiKey: config.apiKey,
        maxRetries: config.modelAttributes?.maxRetries ?? 2, // restore OpenAI SDK default retries
        timeout: config.modelAttributes?.timeout ?? 60000,
      };

      if (config.baseUrl) {
        clientConfig.baseURL = config.baseUrl;
      }

      const keepAliveAgents = this.getKeepAliveAgents(cacheKey);
      clientConfig.httpAgent = keepAliveAgents.httpAgent;
      clientConfig.httpsAgent = keepAliveAgents.httpsAgent;

      // Custom headers support (after sanitization)
      if (sanitizedHeaders && Object.keys(sanitizedHeaders).length > 0) {
        clientConfig.defaultHeaders = sanitizedHeaders;
        this.options.logger?.debug(
          `添加自定义请求头 | provider: ${config.provider} | headers: ${JSON.stringify(sanitizedHeaders)}`,
          'Protocol'
        );
      }

      this.openaiClients.set(cacheKey, new OpenAI(clientConfig));
      this.options.logger?.debug(
        `创建 OpenAI 客户端 | provider: ${config.provider} | baseUrl: ${config.baseUrl || 'default'} | maxRetries: ${clientConfig.maxRetries}`,
        'Protocol'
      );
    }

    return this.openaiClients.get(cacheKey)!;
  }
}
