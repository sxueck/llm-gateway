import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { modelDailyUsageDb, systemConfigDb } from "../db/index.js";
import type { ModelDailyUsageRow } from "../db/repositories/model-daily-usage.repository.js";
import {
  getShanghaiDateKey,
  getShanghaiDayStartOf,
} from "../db/utils/time-buckets.js";
import { memoryLogger } from "./logger.js";

/** system_config key holding `{ [model name]: limitInMillions }`. */
export const MODEL_DAILY_TOKEN_LIMITS_CONFIG_KEY = "model_daily_token_limits";

/** Shared by every writer of the key so the description never drifts. */
export const MODEL_DAILY_TOKEN_LIMITS_DESCRIPTION =
  "模型每日 token 额度上限（单位 M，未配置 = 不限）";

const TOKENS_PER_M = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 10_000;
/** Bound the drain loop: stragglers are picked up by the next sync tick. */
const MAX_FLUSH_PASSES = 8;
const CONFIG_CACHE_TTL_MS = 5_000;

export interface ModelQuotaVerdict {
  allowed: boolean;
  model: string;
  /** 0 = 未配置额度（不限制）。 */
  limitTokens: number;
  usedTokens: number;
  /** Seconds until the next Asia/Shanghai day starts (>= 1 when blocked). */
  retryAfterSeconds: number;
}

export interface ModelQuotaEntry {
  model: string;
  /** Configured ceiling in millions of tokens. */
  limitMillions: number;
  limitTokens: number;
  usedTokens: number;
  requestCount: number;
}

interface DayCell {
  /** Committed day total as last known from the table. */
  dbTokens: number;
  dbRequests: number;
  /** Recorded here, not yet handed to a write. */
  pendingTokens: number;
  pendingRequests: number;
  /** Handed to a write whose commit is not confirmed yet. */
  inFlightTokens: number;
  inFlightRequests: number;
  /** False until the table row for this (day, model) has been read. */
  loaded: boolean;
  /** Serialize the initial DB read with writes of the same cell. */
  loading: Promise<void> | null;
  writing: Promise<void> | null;
}

interface UsageBatch {
  id: string;
  rows: ModelDailyUsageRow[];
  sent: Array<{ key: string; tokens: number; requests: number }>;
}

interface ConfiguredLimits {
  /** model name -> million ceiling. */
  byModel: Record<string, number>;
  loadedAt: number;
}

/**
 * Quota identity of the in-flight request: the model name the client addressed,
 * stamped by the proxy pipeline after model resolution. A per-request holder
 * lets usage settle from the single logging choke point (`logApiRequestToDb`)
 * instead of ~40 per-protocol call sites.
 */
export interface QuotaRequestContext {
  model?: string;
}

const quotaContext = new AsyncLocalStorage<QuotaRequestContext>();

/**
 * Per-model daily token budget.
 *
 * The counting unit is the model the client addressed (`models.name`), so a
 * virtual model and the real model it routes to hold separate budgets, while
 * every virtual key draws from the same model budget. Usage is summed per
 * Asia/Shanghai day in memory and written as merged deltas, so a restart
 * recovers the day's total from `model_daily_usage` instead of starting over.
 *
 * Ceiling: only settled usage is visible to the pre-check, so a request can
 * overshoot the ceiling by its own token count; other instances are picked up
 * once per sync tick, so a multi-instance deployment can overshoot by roughly
 * one tick's worth of traffic. Reads/writes failures fail open — the guard must
 * never take a model's traffic down with it.
 */
class ModelDailyQuotaService {
  /** `${date}|${model}` -> day cell. */
  private cells = new Map<string, DayCell>();
  private limits: ConfiguredLimits | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  /** A failed write keeps this exact payload and id for the next attempt. */
  private retryBatch: UsageBatch | null = null;
  /** Asia/Shanghai date the cells currently belong to. */
  private day = "";

  private cellKey(date: string, model: string): string {
    return `${date}|${model}`;
  }

  private modelOfKey(date: string, key: string): string {
    return key.slice(date.length + 1);
  }

  private cellFor(date: string, model: string): DayCell {
    const key = this.cellKey(date, model);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        dbTokens: 0,
        dbRequests: 0,
        pendingTokens: 0,
        pendingRequests: 0,
        inFlightTokens: 0,
        inFlightRequests: 0,
        loaded: false,
        loading: null,
        writing: null,
      };
      this.cells.set(key, cell);
    }
    return cell;
  }

  private totalTokensOf(cell: DayCell): number {
    return cell.dbTokens + cell.pendingTokens + cell.inFlightTokens;
  }

  private totalRequestsOf(cell: DayCell): number {
    return cell.dbRequests + cell.pendingRequests + cell.inFlightRequests;
  }

  /** Switch to the current Shanghai day, dropping yesterday's cells. */
  private rollDay(now: number): string {
    const today = getShanghaiDateKey(now);
    if (today === this.day) return today;
    const previousDay = this.day;
    this.day = today;
    // Yesterday's budget has expired; the table only keeps the rolling day.
    for (const key of [...this.cells.keys()]) {
      if (!key.startsWith(`${today}|`)) this.cells.delete(key);
    }
    if (previousDay) void this.pruneBefore(today);
    return today;
  }

  private async pruneBefore(date: string): Promise<void> {
    try {
      await modelDailyUsageDb.deleteBefore(date);
    } catch (e: any) {
      memoryLogger.warn(
        `模型每日用量表清理失败(已跳过): ${e?.message || e}`,
        "Quota",
      );
    }
  }

  /** Read the committed baseline without racing a write of the same cell. */
  private async ensureLoaded(date: string, model: string): Promise<DayCell> {
    const cell = this.cellFor(date, model);
    if (cell.loaded) return cell;
    if (cell.loading) {
      await cell.loading;
      return cell;
    }
    if (cell.writing) {
      await Promise.allSettled([cell.writing]);
      // A failed batch sets loaded to prevent an unknown commit being counted twice.
      if (cell.loaded) return cell;
    }

    const loading = (async () => {
      try {
        const stored = await modelDailyUsageDb.getDayUsage(model, date);
        cell.dbTokens = stored.consumedTokens;
        cell.dbRequests = stored.requestCount;
      } catch (e: any) {
        memoryLogger.warn(
          `模型每日用量读取失败(按本进程已计量继续): model=${model} date=${date} err=${e?.message || e}`,
          "Quota",
        );
      }
      cell.loaded = true;
    })();
    cell.loading = loading;
    try {
      await loading;
    } finally {
      if (cell.loading === loading) cell.loading = null;
    }
    return cell;
  }

  /** model name -> million ceiling, cached briefly so the pre-check stays cheap. */
  async getConfiguredLimits(strict: boolean = false): Promise<Record<string, number>> {
    const now = Date.now();
    if (this.limits && now - this.limits.loadedAt < CONFIG_CACHE_TTL_MS) {
      return this.limits.byModel;
    }
    const byModel: Record<string, number> = {};
    try {
      const row = await systemConfigDb.get(MODEL_DAILY_TOKEN_LIMITS_CONFIG_KEY);
      if (row?.value) {
        const parsed = JSON.parse(row.value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (
            const [model, raw] of Object.entries(
              parsed as Record<string, unknown>,
            )
          ) {
            const millions = Number(raw);
            if (model && Number.isFinite(millions) && millions > 0) {
              byModel[model] = millions;
            }
          }
        }
      }
    } catch (e: any) {
      if (strict) throw e;
      memoryLogger.warn(
        `模型每日额度配置解析失败(视为未配置): ${e?.message || e}`,
        "Quota",
      );
    }
    this.limits = { byModel, loadedAt: now };
    return byModel;
  }

  /** Called after the settings page saves the config so it applies at once. */
  invalidateLimits(): void {
    this.limits = null;
  }

  /**
   * Follow a model rename: the ceiling must move with the model (a lost
   * ceiling would silently remove a limit) and so must today's counter (or a
   * rename would silently reset the budget).
   */
  async renameModelKey(
    from: string,
    to: string,
    connection?: PoolConnection,
  ): Promise<() => void> {
    if (!from || !to || from === to) return () => {};
    const limits = await this.getConfiguredLimits(true);
    const millions = limits[from];
    if (!millions) return () => {};

    const next = { ...limits };
    delete next[from];
    next[to] = millions;
    const date = this.rollDay(Date.now());
    await systemConfigDb.set(
      MODEL_DAILY_TOKEN_LIMITS_CONFIG_KEY,
      JSON.stringify(next),
      MODEL_DAILY_TOKEN_LIMITS_DESCRIPTION,
      connection,
    );
    await modelDailyUsageDb.renameDayUsage(date, from, to, connection);

    const commit = () => {
      this.limits = { byModel: next, loadedAt: Date.now() };
      const fromKey = this.cellKey(date, from);
      const toKey = this.cellKey(date, to);
      const source = this.cells.get(fromKey);
      if (source) {
        const target = this.cells.get(toKey);
        if (target) {
          target.dbTokens += source.dbTokens;
          target.dbRequests += source.dbRequests;
          target.pendingTokens += source.pendingTokens;
          target.pendingRequests += source.pendingRequests;
          target.inFlightTokens += source.inFlightTokens;
          target.inFlightRequests += source.inFlightRequests;
        } else {
          this.cells.set(toKey, source);
        }
        this.cells.delete(fromKey);
      }
      if (this.retryBatch) {
        for (const row of this.retryBatch.rows) {
          if (row.model === from) row.model = to;
        }
        for (const delta of this.retryBatch.sent) {
          if (delta.key === fromKey) delta.key = toKey;
        }
      }
    };
    if (connection) return commit;
    commit();
    return () => {};
  }

  limitTokensFor(
    model: string | undefined,
    limits: Record<string, number>,
  ): number {
    if (!model) return 0;
    const millions = limits[model];
    return millions ? Math.round(millions * TOKENS_PER_M) : 0;
  }

  async check(
    model: string | undefined,
    now: number = Date.now(),
  ): Promise<ModelQuotaVerdict> {
    const unlimited: ModelQuotaVerdict = {
      allowed: true,
      model: model || "",
      limitTokens: 0,
      usedTokens: 0,
      retryAfterSeconds: 0,
    };
    if (!model) return unlimited;

    const limits = await this.getConfiguredLimits();
    const limitTokens = this.limitTokensFor(model, limits);
    if (limitTokens <= 0) return unlimited;

    this.startSyncTimer();
    const date = this.rollDay(now);
    const cell = await this.ensureLoaded(date, model);
    const usedTokens = this.totalTokensOf(cell);
    if (usedTokens < limitTokens) {
      return {
        allowed: true,
        model,
        limitTokens,
        usedTokens,
        retryAfterSeconds: 0,
      };
    }

    const dayEnd = getShanghaiDayStartOf(now) + DAY_MS;
    return {
      allowed: false,
      model,
      limitTokens,
      usedTokens,
      retryAfterSeconds: Math.max(1, Math.ceil((dayEnd - now) / 1000)),
    };
  }

  /** Settle one finished request against the model's day budget. */
  record(
    model: string | undefined,
    tokens: number,
    now: number = Date.now(),
  ): void {
    if (!model || !Number.isFinite(tokens) || tokens <= 0) return;
    const cell = this.cellFor(this.rollDay(now), model);
    cell.pendingTokens += tokens;
    cell.pendingRequests += 1;
    this.startSyncTimer();
  }

  private startSyncTimer(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      void this.sync().catch((e: any) => {
        memoryLogger.warn(`模型每日用量同步失败: ${e?.message || e}`, "Quota");
      });
    }, SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
  }

  /** Write pending deltas, then pull the shared day totals back in. */
  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const pass = (async () => {
      for (let attempt = 0; attempt < MAX_FLUSH_PASSES; attempt++) {
        if (!(await this.flushPass())) break;
      }
      if (this.cells.size > 0) await this.refreshDay(this.day);
    })();
    this.syncing = pass;
    try {
      await pass;
    } finally {
      if (this.syncing === pass) this.syncing = null;
    }
  }

  /** Public alias used by graceful shutdown. */
  async flush(): Promise<void> {
    await this.sync();
  }

  /** One merged write. Returns false when nothing was waiting. */
  private async flushPass(): Promise<boolean> {
    await Promise.all(
      [...this.cells.values()].map((cell) => cell.loading),
    );

    if (this.retryBatch) {
      await this.executeBatch(this.retryBatch);
      this.retryBatch = null;
      return true;
    }

    const batch: UsageBatch = { id: randomUUID(), rows: [], sent: [] };
    for (const [key, cell] of this.cells) {
      if (cell.pendingTokens === 0 && cell.pendingRequests === 0) continue;
      const date = key.slice(0, key.indexOf("|"));
      batch.rows.push({
        usageDate: date,
        model: this.modelOfKey(date, key),
        consumedTokens: cell.pendingTokens,
        requestCount: cell.pendingRequests,
      });
      batch.sent.push({
        key,
        tokens: cell.pendingTokens,
        requests: cell.pendingRequests,
      });
      cell.inFlightTokens += cell.pendingTokens;
      cell.inFlightRequests += cell.pendingRequests;
      cell.pendingTokens = 0;
      cell.pendingRequests = 0;
    }
    if (batch.rows.length === 0) return false;

    try {
      await this.executeBatch(batch);
    } catch (e) {
      this.retryBatch = batch;
      throw e;
    }
    return true;
  }

  private async executeBatch(batch: UsageBatch): Promise<void> {
    const cells = batch.sent
      .map((delta) => this.cells.get(delta.key))
      .filter((cell): cell is DayCell => !!cell);
    const writing = Promise.resolve().then(() =>
      modelDailyUsageDb.addUsage(batch.rows, batch.id),
    );
    for (const cell of cells) cell.writing = writing;

    try {
      await writing;
      for (const delta of batch.sent) {
        const cell = this.cells.get(delta.key);
        if (!cell) continue;
        cell.inFlightTokens -= delta.tokens;
        cell.inFlightRequests -= delta.requests;
        cell.dbTokens += delta.tokens;
        cell.dbRequests += delta.requests;
      }
    } catch (e) {
      for (const cell of cells) cell.loaded = true;
      throw e;
    } finally {
      for (const cell of cells) {
        if (cell.writing === writing) cell.writing = null;
      }
    }
  }

  /** Pull today's committed totals so other instances' traffic counts here too. */
  private async refreshDay(date: string): Promise<void> {
    let totals: Awaited<
      ReturnType<typeof modelDailyUsageDb.getDayTotals>
    > = [];
    try {
      totals = await modelDailyUsageDb.getDayTotals(date);
    } catch (e: any) {
      memoryLogger.warn(
        `模型每日用量刷新失败(保留本进程计量): ${e?.message || e}`,
        "Quota",
      );
      return;
    }
    const byModel = new Map(
      totals.map((row) => [row.model, row] as const),
    );
    for (const [key, cell] of this.cells) {
      if (!key.startsWith(`${date}|`)) continue;
      const row = byModel.get(this.modelOfKey(date, key));
      cell.dbTokens = row?.consumedTokens ?? 0;
      cell.dbRequests = row?.requestCount ?? 0;
      cell.loaded = true;
    }
  }

  /** Day totals for every configured model, for the settings page read-out. */
  async snapshot(now: number = Date.now()): Promise<ModelQuotaEntry[]> {
    const limits = await this.getConfiguredLimits();
    const date = this.rollDay(now);
    const entries: ModelQuotaEntry[] = [];
    for (const [model, millions] of Object.entries(limits)) {
      const cell = await this.ensureLoaded(date, model);
      entries.push({
        model,
        limitMillions: millions,
        limitTokens: this.limitTokensFor(model, limits),
        usedTokens: this.totalTokensOf(cell),
        requestCount: this.totalRequestsOf(cell),
      });
    }
    return entries.sort((a, b) => b.usedTokens - a.usedTokens);
  }

  resetForTesting(): void {
    this.cells.clear();
    this.limits = null;
    this.syncing = null;
    this.retryBatch = null;
    this.day = "";
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

export const modelDailyQuota = new ModelDailyQuotaService();

/**
 * Wrap the rest of the request lifecycle so the logging choke point can find
 * the addressed model. Callers must use the callback-style `done()` signature:
 * an async hook would leave the async-local scope before the handler runs.
 */
export function runWithQuotaContext<T>(fn: () => T): T {
  return quotaContext.run({}, fn);
}

/** Stamp the addressed model name (called by the pipeline after resolution). */
export function stampQuotaModel(model: string | undefined): void {
  const store = quotaContext.getStore();
  if (store) store.model = model;
}

export function currentQuotaModel(): string | undefined {
  return quotaContext.getStore()?.model;
}
