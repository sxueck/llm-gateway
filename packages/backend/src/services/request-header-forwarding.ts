import { systemConfigDb } from '../db/index.js';
import { memoryLogger } from './logger.js';

export type ForwardedRequestHeaders = Record<string, string | string[] | undefined>;

export type RequestHeaderForwardingConfig = {
  // When enabled, forward the client's User-Agent to upstream.
  // When disabled, upstream requests use the SDK/runtime default UA.
  forwardClientUserAgent: boolean;
};

const DEFAULT_CONFIG: RequestHeaderForwardingConfig = {
  forwardClientUserAgent: false,
};

export class RequestHeaderForwardingService {
  private config: RequestHeaderForwardingConfig = { ...DEFAULT_CONFIG };

  constructor() {}

  private async loadConfig() {
    try {
      const uaCfg = await systemConfigDb.get('forward_client_user_agent');
      this.config = {
        forwardClientUserAgent: uaCfg ? uaCfg.value === 'true' : DEFAULT_CONFIG.forwardClientUserAgent,
      };
      memoryLogger.debug(
        `请求头透传配置已加载 | forwardClientUserAgent: ${this.config.forwardClientUserAgent}`,
        'Config'
      );
    } catch (error) {
      // Don't crash request path on config load.
      memoryLogger.error(`加载请求头透传配置失败: ${error}`, 'Config');
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  async reloadConfig() {
    await this.loadConfig();
  }

  getConfig(): RequestHeaderForwardingConfig {
    return { ...this.config };
  }

  /**
   * Build a minimal, safe set of forwarded headers for upstream requests.
   * - Always forward: Origin / Referer (when present)
   * - Optionally forward: User-Agent (controlled by system setting)
   */
  buildForwardedHeaders(requestHeaders: ForwardedRequestHeaders): Record<string, string> {
    const out: Record<string, string> = {};

    const rawOrigin = requestHeaders.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (origin) out.origin = String(origin);

    const rawReferer = requestHeaders.referer || (requestHeaders as any).referrer;
    const referer = Array.isArray(rawReferer) ? rawReferer[0] : rawReferer;
    if (referer) out.referer = String(referer);

    if (this.config.forwardClientUserAgent) {
      const rawUa = requestHeaders['user-agent'];
      const ua = Array.isArray(rawUa) ? rawUa[0] : rawUa;
      if (ua) out['user-agent'] = String(ua);
    }

    return out;
  }
}

export const requestHeaderForwardingService = new RequestHeaderForwardingService();
