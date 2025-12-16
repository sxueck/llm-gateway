import { memoryLogger } from './logger.js';

export class ThreatIpBlocker {
  private threatIps: Set<string> = new Set();
  private lastUpdated: number = 0;
  private updating: boolean = false;
  private lastBlockedIp: string | null = null;
  private lastBlockedAt: number = 0;

  // 默认 6 小时刷新一次
  private readonly refreshIntervalMs = 6 * 60 * 60 * 1000;
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  constructor() {
    // 后台懒加载，不在构造函数中抛错
    this.refresh().catch((err) => {
      memoryLogger.warn(`初始化威胁 IP 列表失败: ${err?.message || err}`, 'ThreatIP');
    });
  }

  async refresh() {
    if (this.updating) return;
    this.updating = true;
    try {
      const url = process.env.THREAT_IP_SOURCE_URL ||
        'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt';

      memoryLogger.info(`开始拉取威胁 IP 列表: ${url}`, 'ThreatIP');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal } as any);
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`下载失败: HTTP ${res.status}`);
      }

      const blob = await res.blob();
      if (blob.size > this.MAX_FILE_SIZE) {
        throw new Error(`文件过大: ${blob.size} bytes (上限 ${this.MAX_FILE_SIZE} bytes)`);
      }

      const text = await blob.text();
      // 简单验证内容是否看起来像文本
      if (text.includes('\0')) {
        throw new Error('文件内容包含非法字符，可能不是文本文件');
      }

      const nextSet = new Set<string>();
      let count = 0;

      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // ipsum.txt 典型格式: "1.2.3.4,123,info..." 或直接是 IP
        const ip = trimmed.split(/[ ,]/)[0];
        if (ip && this.isValidIp(ip)) {
          nextSet.add(ip);
          count++;
        }
      }

      this.threatIps = nextSet;
      this.lastUpdated = Date.now();
      memoryLogger.info(`威胁 IP 列表更新完成: 共 ${count} 个 IP`, 'ThreatIP');
    } catch (err: any) {
      memoryLogger.error(`刷新威胁 IP 列表失败: ${err?.message || err}`, 'ThreatIP');
    } finally {
      this.updating = false;
    }
  }

  private isValidIp(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  private ensureFreshAsync() {
    const now = Date.now();
    if (now - this.lastUpdated > this.refreshIntervalMs) {
      this.refresh().catch(() => {});
    }
  }

  isThreat(ipRaw: string | string[] | undefined): boolean {
    if (!ipRaw) return false;

    this.ensureFreshAsync();

    const candidate = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
    if (!candidate) return false;

    const first = candidate.split(',')[0].trim();

    const ip = first.includes(':') && first.indexOf(':') === first.lastIndexOf(':')
      ? first.split(':')[0]
      : first;

    const isThreat = this.threatIps.has(ip);
    if (isThreat) {
      this.lastBlockedIp = ip;
      this.lastBlockedAt = Date.now();
    }
    return isThreat;
  }

  getLastBlockedInfo() {
    return {
      ip: this.lastBlockedIp,
      timestamp: this.lastBlockedAt
    };
  }
}

export const threatIpBlocker = new ThreatIpBlocker();
