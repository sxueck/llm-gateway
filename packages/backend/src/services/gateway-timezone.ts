import { systemConfigRepository } from "../db/repositories/system-config.repository.js";
import { memoryLogger } from "./logger.js";

export const DEFAULT_GATEWAY_TIMEZONE = "Asia/Shanghai";
export const GATEWAY_TIMEZONE_CONFIG_KEY = "gateway_timezone";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  // ast-grep-ignore: no-catch-swallow
  } catch {
    return false;
  }
}

/**
 * Gateway-wide IANA timezone (system_config `gateway_timezone`, default
 * Asia/Shanghai). Day boundaries of daily quotas and daily statistics
 * (`db/utils/time-buckets.ts`) follow this setting.
 *
 * Reads are served from a process-local cache because the quota hot path
 * resolves the timezone synchronously per request. The cache refreshes on
 * save (same process) and, as a ceiling for multi-instance deployments, at
 * most once per TTL in the background — a changed value lands on other
 * instances within the TTL, never blocks the caller.
 */
class GatewayTimezoneService {
  static readonly REFRESH_TTL_MS = 60_000;

  private timezone = DEFAULT_GATEWAY_TIMEZONE;
  private loadedAt = 0;
  private reloading: Promise<void> | null = null;

  async initialize(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const cfg = await systemConfigRepository.get(GATEWAY_TIMEZONE_CONFIG_KEY);
      const value = cfg?.value?.trim();
      if (value && isValidTimeZone(value)) {
        this.timezone = value;
      } else {
        if (value) {
          memoryLogger.warn(
            `system_config 中的网关时区无效，回退为 ${DEFAULT_GATEWAY_TIMEZONE}: ${value}`,
            "Config",
          );
        }
        this.timezone = DEFAULT_GATEWAY_TIMEZONE;
      }
    } catch (error: any) {
      memoryLogger.warn(
        `加载网关时区配置失败，沿用当前值 ${this.timezone}: ${error.message}`,
        "Config",
      );
    } finally {
      this.loadedAt = Date.now();
    }
  }

  get(): string {
    // loadedAt === 0 means nobody loaded the config yet (e.g. unit tests
    // without a database): serve the default instead of spawning a refresh
    // that would reach for a connection pool that may not exist.
    if (
      this.loadedAt > 0 &&
      Date.now() - this.loadedAt > GatewayTimezoneService.REFRESH_TTL_MS &&
      !this.reloading
    ) {
      this.reloading = this.reload().finally(() => {
        this.reloading = null;
      });
    }
    return this.timezone;
  }

  async set(tz: string): Promise<void> {
    const value = tz.trim();
    if (!isValidTimeZone(value)) {
      throw new Error(`无效的 IANA 时区: ${tz}`);
    }
    await systemConfigRepository.set(
      GATEWAY_TIMEZONE_CONFIG_KEY,
      value,
      "网关时区（配额与按天统计的自然日边界）",
    );
    this.timezone = value;
    this.loadedAt = Date.now();
  }
}

export const gatewayTimezone = new GatewayTimezoneService();
