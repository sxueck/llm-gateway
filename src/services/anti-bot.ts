import { memoryLogger } from './logger.js';
import { loadAntiBotConfig, type AntiBotConfig } from '../utils/anti-bot-config.js';

const BOT_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /scraper/i,
  /curl/i,
  /wget/i,
  /python/i,
  /requests/i,
  /httpie/i,
  /postman/i,
  /insomnia/i,
  /http-client/i,
  /axios/i,
  /fetch/i,
  /java/i,
  /go-http/i,
  /rust/i,
  /dart/i,
  /php/i,
  /perl/i,
  /ruby/i,
  /googlebot/i,
  /bingbot/i,
  /slurp/i,
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /pingdom/i,
  /uptimerobot/i,
  /statuscake/i,
  /newrelic/i,
  /datadog/i,
  /prometheus/i,
  /grafana/i,
  /selenium/i,
  /puppeteer/i,
  /chromedriver/i,
  /geckodriver/i,
  /webdriver/i,
];

const SUSPICIOUS_PATTERNS = [
  /^Mozilla\/5\.0$/i,
  /^Mozilla\/4\.0$/i,
  /^[a-z]+$/i,
  /[<>\"'&]/,
  /^.{1,10}$/,
];

export class AntiBotService {
  private config: AntiBotConfig = {
    enabled: false,
    blockBots: true,
    blockSuspicious: false,
    allowedUserAgents: [],
    blockedUserAgents: [],
    logOnly: true,
    logHeaders: false,
  };

  constructor() {
    this.loadConfig();
  }

  private async loadConfig() {
    try {
      this.config = await loadAntiBotConfig();
      memoryLogger.debug(
        `反爬虫配置已加载 | enabled: ${this.config.enabled} | logHeaders: ${this.config.logHeaders} | logOnly: ${this.config.logOnly}`,
        'AntiBot'
      );
    } catch (error) {
      memoryLogger.error(`加载反爬虫配置失败: ${error}`, 'AntiBot');
    }
  }

  async reloadConfig() {
    await this.loadConfig();
  }

  private isAllowed(userAgent: string): boolean {
    return this.config.allowedUserAgents.some(pattern => {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(userAgent);
      } catch {
        return userAgent.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  private isBlocked(userAgent: string): boolean {
    return this.config.blockedUserAgents.some(pattern => {
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(userAgent);
      } catch {
        return userAgent.toLowerCase().includes(pattern.toLowerCase());
      }
    });
  }

  private isBot(userAgent: string): boolean {
    return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
  }

  private isSuspicious(userAgent: string): boolean {
    return SUSPICIOUS_PATTERNS.some(pattern => pattern.test(userAgent));
  }

  detect(userAgent: string): {
    isBot: boolean;
    isSuspicious: boolean;
    isBlocked: boolean;
    shouldBlock: boolean;
    reason: string;
  } {
    if (!this.config.enabled) {
      return {
        isBot: false,
        isSuspicious: false,
        isBlocked: false,
        shouldBlock: false,
        reason: '反爬虫功能未启用',
      };
    }

    const normalizedUA = userAgent.trim();
    
    // 检查白名单
    if (this.isAllowed(normalizedUA)) {
      return {
        isBot: false,
        isSuspicious: false,
        isBlocked: false,
        shouldBlock: false,
        reason: '在白名单中',
      };
    }

    // 检查黑名单
    if (this.isBlocked(normalizedUA)) {
      return {
        isBot: true,
        isSuspicious: false,
        isBlocked: true,
        shouldBlock: true,
        reason: '在黑名单中',
      };
    }

    // 检查是否为爬虫
    const isBot = this.isBot(normalizedUA);
    if (isBot && this.config.blockBots) {
      return {
        isBot: true,
        isSuspicious: false,
        isBlocked: false,
        shouldBlock: !this.config.logOnly,
        reason: '检测到爬虫User-Agent',
      };
    }

    // 检查是否可疑
    const isSuspicious = this.isSuspicious(normalizedUA);
    if (isSuspicious && this.config.blockSuspicious) {
      return {
        isBot: false,
        isSuspicious: true,
        isBlocked: false,
        shouldBlock: !this.config.logOnly,
        reason: '检测到可疑User-Agent',
      };
    }

    return {
      isBot,
      isSuspicious,
      isBlocked: false,
      shouldBlock: false,
      reason: isBot ? '检测到爬虫但未拦截' : '正常User-Agent',
    };
  }

  logDetection(userAgent: string, result: ReturnType<typeof this.detect>, ip?: string, headers?: Record<string, string | string[] | undefined>) {
    const logLevel = result.shouldBlock ? 'WARN' : 'INFO';
    const message = `反爬虫检测 | IP: ${ip || 'unknown'} | UA: ${userAgent.substring(0, 100)}${userAgent.length > 100 ? '...' : ''} | 结果: ${result.reason}`;
    
    if (result.shouldBlock) {
      memoryLogger.warn(message, 'AntiBot');
    } else if (result.isBot || result.isSuspicious) {
      memoryLogger.info(message, 'AntiBot');
    } else {
      memoryLogger.debug(message, 'AntiBot');
    }

    // 如果启用了记录请求头功能，则输出完整请求头
    if (this.config.logHeaders && headers) {
      const sanitizedHeaders = this.sanitizeHeaders(headers);
      const headersMessage = `Headers: ${JSON.stringify(sanitizedHeaders, null, 2)}`;
      memoryLogger.debug(headersMessage, 'AntiBot');
    }
  }

  private sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      
      const lowerKey = key.toLowerCase();
      let headerValue = Array.isArray(value) ? value.join(', ') : value;
      
      // 对敏感头进行脱敏处理
      if (lowerKey === 'authorization') {
        // 保留前缀和部分密钥信息用于调试
        if (headerValue.startsWith('Bearer ')) {
          const token = headerValue.substring(7);
          if (token.length > 10) {
            headerValue = `Bearer ${token.substring(0, 6)}...${token.substring(token.length - 4)}`;
          }
        } else if (headerValue.length > 10) {
          headerValue = `${headerValue.substring(0, 6)}...${headerValue.substring(headerValue.length - 4)}`;
        }
      } else if (lowerKey === 'cookie' || lowerKey === 'set-cookie') {
        // 完全隐藏 cookie 内容
        headerValue = '[REDACTED]';
      }
      
      sanitized[key] = headerValue;
    }
    return sanitized;
  }

  getConfig(): AntiBotConfig {
    return { ...this.config };
  }
}

export const antiBotService = new AntiBotService();