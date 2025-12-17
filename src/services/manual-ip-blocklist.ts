import { blockedIpDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { normalizeIp } from '../utils/ip.js';

export interface BlockedIpEntry {
  ip: string;
  reason: string | null;
  createdAt: number;
  createdBy: string | null;
}

class ManualIpBlocklistService {
  private blockedIps = new Map<string, BlockedIpEntry>();
  private initialized = false;
  private loading: Promise<void> | null = null;

  private async loadFromDatabase() {
    const rows = await blockedIpDb.getAll();
    this.blockedIps.clear();
    for (const row of rows) {
      this.blockedIps.set(row.ip, {
        ip: row.ip,
        reason: row.reason,
        createdAt: Number(row.created_at) || Date.now(),
        createdBy: row.created_by,
      });
    }
    this.initialized = true;
    memoryLogger.info(`手动拦截列表已加载: ${this.blockedIps.size} 个 IP`, 'ManualBlock');
  }

  async init() {
    if (this.initialized || this.loading) {
      return this.loading;
    }
    this.loading = this.loadFromDatabase().catch((error) => {
      memoryLogger.error(`加载手动拦截列表失败: ${error?.message || error}`, 'ManualBlock');
      throw error;
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async reload() {
    this.initialized = false;
    await this.init();
  }

  private normalize(ip: string): string {
    const normalized = normalizeIp(ip);
    if (!normalized) {
      throw new Error('无效的 IP 地址');
    }
    return normalized;
  }

  isBlocked(ipRaw: string | string[] | undefined): BlockedIpEntry | null {
    if (!ipRaw) {
      return null;
    }
    const candidate = Array.isArray(ipRaw) ? ipRaw[0] : ipRaw;
    if (!candidate) {
      return null;
    }
    if (!this.initialized && !this.loading) {
      this.init().catch(() => {});
    }
    const normalized = normalizeIp(candidate);
    if (!normalized) {
      return null;
    }
    return this.blockedIps.get(normalized) || null;
  }

  async block(ip: string, reason?: string | null, createdBy?: string | null): Promise<BlockedIpEntry> {
    const normalized = this.normalize(ip);
    const trimmedReason = reason ? reason.trim().slice(0, 250) : null;
    const entry: BlockedIpEntry = {
      ip: normalized,
      reason: trimmedReason,
      createdAt: Date.now(),
      createdBy: createdBy || null,
    };
    await blockedIpDb.upsert({
      ip: normalized,
      reason: trimmedReason,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy || undefined,
    });
    this.blockedIps.set(normalized, entry);
    memoryLogger.warn(`手动拦截 IP: ${normalized}${trimmedReason ? ` | 原因: ${trimmedReason}` : ''}`, 'ManualBlock');
    return entry;
  }

  getLastBlocked(): BlockedIpEntry | null {
    if (this.blockedIps.size === 0) {
      return null;
    }
    let latest: BlockedIpEntry | null = null;
    for (const entry of this.blockedIps.values()) {
      if (!latest || entry.createdAt > latest.createdAt) {
        latest = entry;
      }
    }
    return latest;
  }

  getBlockedMap(): Map<string, BlockedIpEntry> {
    return this.blockedIps;
  }
}

export const manualIpBlocklist = new ManualIpBlocklistService();
