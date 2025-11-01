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
  };

  constructor() {
    this.loadConfig();
  }

  private async loadConfig() {
    try {
      this.config = await loadAntiBotConfig();
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

  logDetection(userAgent: string, result: ReturnType<typeof this.detect>, ip?: string) {
    const logLevel = result.shouldBlock ? 'WARN' : 'INFO';
    const message = `反爬虫检测 | IP: ${ip || 'unknown'} | UA: ${userAgent.substring(0, 100)}${userAgent.length > 100 ? '...' : ''} | 结果: ${result.reason}`;
    
    if (result.shouldBlock) {
      memoryLogger.warn(message, 'AntiBot');
    } else if (result.isBot || result.isSuspicious) {
      memoryLogger.info(message, 'AntiBot');
    } else {
      memoryLogger.debug(message, 'AntiBot');
    }
  }

  getConfig(): AntiBotConfig {
    return { ...this.config };
  }
}

export const antiBotService = new AntiBotService();