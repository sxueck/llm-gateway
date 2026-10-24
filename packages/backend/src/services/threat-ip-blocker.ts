import { memoryLogger } from './logger.js';
import { upstreamFetch } from '../utils/upstream-fetch.js';
import { normalizeIp } from '../utils/ip.js';

const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

function readMinHits(): number {
  const raw = process.env.THREAT_IP_MIN_HITS;
  if (raw === undefined || raw.trim() === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.floor(n);
}

export class ThreatIpBlocker {
  private threatIps: Set<string> = new Set();
  private lastUpdated: number = 0;
  private lastAttemptAt: number = 0;
  private refreshPromise: Promise<void> | null = null;
  private lastBlockedIp: string | null = null;
  private lastBlockedAt: number = 0;
  private blockedCount: number = 0;

  // 默认 6 小时刷新一次
  private readonly refreshIntervalMs = 6 * 60 * 60 * 1000;
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  constructor() {
    this.refresh().catch(() => {});
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.pullThreatList().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async pullThreatList(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const url = process.env.THREAT_IP_SOURCE_URL ||
        'https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt';
      const minHits = readMinHits();

      memoryLogger.info(`开始拉取威胁 IP 列表: ${url}`, 'ThreatIP');

      const res = await upstreamFetch(url, { timeoutMs: 15000 });
      if (!res.ok) {
        throw new Error(`下载失败: HTTP ${res.status}`);
      }

      const blob = await res.blob();
      if (blob.size > this.MAX_FILE_SIZE) {
        throw new Error(`文件过大: ${blob.size} bytes (上限 ${this.MAX_FILE_SIZE} bytes)`);
      }

      const text = await blob.text();
      if (text.includes('\0')) {
        throw new Error('文件内容包含非法字符，可能不是文本文件');
      }

      const nextSet = new Set<string>();

      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.replace(/^\uFEFF/, '').trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parts = trimmed.split(/[\s,]+/);
        const ip = parts[0];
        if (!ip || !this.isValidIp(ip)) continue;

        if (parts.length > 1) {
          const hits = Number(parts[1]);
          if (Number.isFinite(hits) && hits < minHits) continue;
        }

        nextSet.add(ip);
      }

      if (nextSet.size === 0) {
        throw new Error('解析结果为空');
      }

      this.threatIps = nextSet;
      this.lastUpdated = Date.now();
      memoryLogger.info(
        `威胁 IP 列表更新完成: 共 ${this.threatIps.size} 个 IP (min hits ${minHits})`,
        'ThreatIP'
      );
    } catch (err: any) {
      memoryLogger.error(`刷新威胁 IP 列表失败: ${err?.message || err}`, 'ThreatIP');
      throw err;
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
    if (this.refreshPromise) return;
    const now = Date.now();
    const stale = this.lastUpdated === 0 || now - this.lastUpdated > this.refreshIntervalMs;
    if (!stale) return;
    if (now - this.lastAttemptAt < FAILURE_BACKOFF_MS) return;
    this.refresh().catch(() => {});
  }

  private normalizeCandidate(ipRaw: string | string[]): string {
    const candidate = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
    if (!candidate) return '';
    let ip = normalizeIp(candidate);
    if (ip.includes(':') && ip.indexOf(':') === ip.lastIndexOf(':')) {
      ip = normalizeIp(ip.split(':')[0]);
    }
    return ip;
  }

  isThreat(ipRaw: string | string[] | undefined): boolean {
    if (!ipRaw) return false;

    this.ensureFreshAsync();

    const ip = this.normalizeCandidate(ipRaw);
    if (!ip || ip === 'unknown') return false;

    const isThreat = this.threatIps.has(ip);
    if (isThreat) {
      this.lastBlockedIp = ip;
      this.lastBlockedAt = Date.now();
      this.blockedCount += 1;
    }
    return isThreat;
  }

  getLastBlockedInfo() {
    return {
      ip: this.lastBlockedIp,
      timestamp: this.lastBlockedAt
    };
  }

  getStats() {
    return {
      blockedCount: this.blockedCount,
      totalThreatIps: this.threatIps.size,
      lastBlockedIp: this.lastBlockedIp,
      lastBlockedAt: this.lastBlockedAt,
      lastUpdated: this.lastUpdated,
    };
  }
}

export const threatIpBlocker = new ThreatIpBlocker();
