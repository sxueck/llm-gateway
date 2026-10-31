import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import {
  virtualKeyModelQuotaDb,
  virtualKeyModelUsageDb,
} from "../db/index.js";
import type { VirtualKeyModelUsageDelta } from "../db/repositories/virtual-key-quota.repository.js";
import {
  getDateKey,
  getDayStartOfDateKeyInTz,
} from "../db/utils/time-buckets.js";
import { gatewayTimezone } from "./gateway-timezone.js";
import { memoryLogger } from "./logger.js";

const TOKENS_PER_M = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 10_000;
/** Bound the drain loop: stragglers are picked up by the next sync tick. */
const MAX_FLUSH_PASSES = 8;
const LIMITS_CACHE_TTL_MS = 5_000;

export interface VirtualKeyQuotaVerdict {
  allowed: boolean;
  virtualKeyId: string;
  model: string;
  /** 0 = 未配置额度（不限制）。 */
  limitTokens: number;
  usedTokens: number;
  /** Seconds until the next gateway-timezone day starts (>= 1 when blocked). */
  retryAfterSeconds: number;
}

export interface VirtualKeyQuotaEntry {
  model: string;
  /** Configured ceiling in millions of tokens. */
  limitMillions: number;
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
  /** False until the table row for this (day, key, model) has been read. */
  loaded: boolean;
  /** Serialize the initial DB read with writes of the same cell. */
  loading: Promise<void> | null;
  writing: Promise<void> | null;
}

interface UsageBatch {
  id: string;
  rows: VirtualKeyModelUsageDelta[];
  sent: Array<{ key: string; tokens: number; requests: number }>;
}

interface CachedLimits {
  /** virtual key id -> (model name -> million ceiling). */
  byKey: Map<string, Map<string, number>>;
  loadedAt: number;
}

/**
 * The virtual key is added by the logging choke point, which — unlike the ~40
 * per-protocol call sites — always has the authenticated key at hand.
 */
export interface QuotaRequestContext {
  model?: string;
}

const quotaContext = new AsyncLocalStorage<QuotaRequestContext>();

/**
 * Per-virtual-key, per-model daily token budget (issue 39), replacing the
 * retired global model quota.
 *
 * The counting unit is (virtual key id, model name the client addressed)
 * (`models.name`), so a virtual model and the real model it routes to hold
 * separate budgets, and every virtual key draws from its own pool. Usage is
 * summed per gateway-timezone day in memory and written as merged deltas, so a
 * restart recovers the day's total from `virtual_key_model_daily_usage` instead
 * of starting over. Usage is recorded even for models without a configured
 * ceiling, so setting a limit mid-day already sees today's traffic.
 *
 * Ceiling: only settled usage is visible to the pre-check, so a request can
 * overshoot the ceiling by its own token count; other instances are picked up
 * once per sync tick, so a multi-instance deployment can overshoot by roughly
 * one tick's worth of traffic. Reads/writes failures fail open — the guard must
 * never take a key's traffic down with it.
 */
class VirtualKeyQuotaService {
  /** `${date}|${virtualKeyId}|${model}` -> day cell. */
  private cells = new Map<string, DayCell>();
  private limits: CachedLimits | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  /** A failed write keeps this exact payload and id for the next attempt. */
  private retryBatch: UsageBatch | null = null;
  private day = "";
  /** Day whose older table rows still owe a prune. */
  private pruneDue: string | null = null;

  private cellKey(date: string, virtualKeyId: string, model: string): string {
    return `${date}|${virtualKeyId}|${model}`;
  }

  private splitKey(key: string): {
    date: string;
    virtualKeyId: string;
    model: string;
  } {
    const firstPipe = key.indexOf("|");
    const date = key.slice(0, firstPipe);
    const rest = key.slice(firstPipe + 1);
    const secondPipe = rest.indexOf("|");
    return {
      date,
      virtualKeyId: rest.slice(0, secondPipe),
      model: rest.slice(secondPipe + 1),
    };
  }

  private cellFor(
    date: string,
    virtualKeyId: string,
    model: string,
  ): DayCell {
    const key = this.cellKey(date, virtualKeyId, model);
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

  /**
   * Cells of yesterday's budget are dropped unless they still owe the table a
   * write, so usage recorded before midnight is flushed under its own date.
   */
  private rollDay(now: number): string {
    const today = getDateKey(now);
    if (today === this.day) return today;
    const previousDay = this.day;
    this.day = today;
    let owesOldDay = this.retryBatch !== null;
    for (const [key, cell] of [...this.cells.entries()]) {
      if (key.startsWith(`${today}|`)) continue;
      if (this.owesWrite(cell)) {
        owesOldDay = true;
        continue;
      }
      this.cells.delete(key);
    }
    if (!previousDay) return today;
    if (owesOldDay) {
      // Defer the prune until the outstanding old-day deltas have landed: a
      // DELETE racing that write could re-create a stale row, and deleting the
      // batch markers could make a pending retry apply twice.
      this.pruneDue = today;
    } else {
      this.pruneDue = null;
      void this.pruneBefore(today);
    }
    return today;
  }

  private owesWrite(cell: DayCell): boolean {
    return (
      cell.pendingTokens !== 0 ||
      cell.pendingRequests !== 0 ||
      cell.inFlightTokens !== 0 ||
      cell.inFlightRequests !== 0
    );
  }

  private retireSettledCells(): void {
    const prefix = `${this.day}|`;
    for (const [key, cell] of [...this.cells.entries()]) {
      if (key.startsWith(prefix)) continue;
      if (this.owesWrite(cell)) continue;
      this.cells.delete(key);
    }
  }

  private async pruneBefore(date: string): Promise<void> {
    try {
      await virtualKeyModelUsageDb.deleteBefore(date);
    } catch (e: any) {
      memoryLogger.warn(
        `虚拟密钥每日用量表清理失败(已跳过): ${e?.message || e}`,
        "Quota",
      );
    }
  }

  /** The deferred prune, run only once nothing older-day is outstanding. */
  private async pruneDueDay(): Promise<void> {
    const date = this.pruneDue;
    if (!date) return;
    if (this.retryBatch) return;
    const prefix = `${date}|`;
    if ([...this.cells.keys()].some((key) => !key.startsWith(prefix))) return;
    this.pruneDue = null;
    await this.pruneBefore(date);
  }

  /** Read the committed baseline without racing a write of the same cell. */
  private async ensureLoaded(
    date: string,
    virtualKeyId: string,
    model: string,
  ): Promise<DayCell> {
    const cell = this.cellFor(date, virtualKeyId, model);
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
        const stored = await virtualKeyModelUsageDb.getDayUsage(
          virtualKeyId,
          model,
          date,
        );
        cell.dbTokens = stored.consumedTokens;
        cell.dbRequests = stored.requestCount;
      } catch (e: any) {
        memoryLogger.warn(
          `虚拟密钥每日用量读取失败(按本进程已计量继续): keyId=${virtualKeyId} model=${model} date=${date} err=${e?.message || e}`,
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

  /**
   * Every configured ceiling, cached briefly so the pre-check stays cheap.
   * Fail-open: on read failure the snapshot is empty and everything is allowed.
   */
  async getConfiguredLimits(): Promise<Map<string, Map<string, number>>> {
    const now = Date.now();
    if (this.limits && now - this.limits.loadedAt < LIMITS_CACHE_TTL_MS) {
      return this.limits.byKey;
    }
    const byKey = new Map<string, Map<string, number>>();
    try {
      const rows = await virtualKeyModelQuotaDb.getAll();
      for (const row of rows) {
        const millions = row.limitMillions;
        if (!row.model || !Number.isFinite(millions) || millions <= 0) continue;
        const models = byKey.get(row.virtualKeyId) ?? new Map<string, number>();
        models.set(row.model, millions);
        byKey.set(row.virtualKeyId, models);
      }
    } catch (e: any) {
      memoryLogger.warn(
        `虚拟密钥模型额度读取失败(视为未配置): ${e?.message || e}`,
        "Quota",
      );
    }
    this.limits = { byKey, loadedAt: now };
    return byKey;
  }

  /** Called after the admin bulk save so it applies at once on this instance. */
  invalidateLimits(): void {
    this.limits = null;
  }

  limitTokensFor(
    virtualKeyId: string | undefined,
    model: string | undefined,
    limits: Map<string, Map<string, number>>,
  ): number {
    if (!virtualKeyId || !model) return 0;
    const millions = limits.get(virtualKeyId)?.get(model);
    return millions ? Math.round(millions * TOKENS_PER_M) : 0;
  }

  async check(
    virtualKeyId: string | undefined,
    model: string | undefined,
    now: number = Date.now(),
  ): Promise<VirtualKeyQuotaVerdict> {
    const unlimited: VirtualKeyQuotaVerdict = {
      allowed: true,
      virtualKeyId: virtualKeyId || "",
      model: model || "",
      limitTokens: 0,
      usedTokens: 0,
      retryAfterSeconds: 0,
    };
    if (!virtualKeyId || !model) return unlimited;

    const limits = await this.getConfiguredLimits();
    const limitTokens = this.limitTokensFor(virtualKeyId, model, limits);
    if (limitTokens <= 0) return unlimited;

    this.startSyncTimer();
    const date = this.rollDay(now);
    const cell = await this.ensureLoaded(date, virtualKeyId, model);
    const usedTokens = this.totalTokensOf(cell);
    if (usedTokens < limitTokens) {
      return {
        allowed: true,
        virtualKeyId,
        model,
        limitTokens,
        usedTokens,
        retryAfterSeconds: 0,
      };
    }

    const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS)
      .toISOString().slice(0, 10);
    const dayEnd = getDayStartOfDateKeyInTz(nextDate, gatewayTimezone.get());
    return {
      allowed: false,
      virtualKeyId,
      model,
      limitTokens,
      usedTokens,
      retryAfterSeconds: Math.max(1, Math.ceil((dayEnd - now) / 1000)),
    };
  }

  record(
    virtualKeyId: string | undefined,
    model: string | undefined,
    tokens: number,
    now: number = Date.now(),
  ): void {
    if (!virtualKeyId || !model || !Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    const cell = this.cellFor(this.rollDay(now), virtualKeyId, model);
    cell.pendingTokens += tokens;
    cell.pendingRequests += 1;
    this.startSyncTimer();
  }

  private startSyncTimer(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      void this.sync().catch((e: any) => {
        memoryLogger.warn(`虚拟密钥每日用量同步失败: ${e?.message || e}`, "Quota");
      });
    }, SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
  }

  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const pass = (async () => {
      for (let attempt = 0; attempt < MAX_FLUSH_PASSES; attempt++) {
        if (!(await this.flushPass())) break;
      }
      this.retireSettledCells();
      if (this.cells.size > 0) await this.refreshDay(this.day);
      await this.pruneDueDay();
    })();
    this.syncing = pass;
    try {
      await pass;
    } finally {
      if (this.syncing === pass) this.syncing = null;
    }
  }

  async flush(): Promise<void> {
    await this.sync();
  }

  /** Returns false when nothing was waiting. */
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
      const { date, virtualKeyId, model } = this.splitKey(key);
      batch.rows.push({
        usageDate: date,
        virtualKeyId,
        model,
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
      virtualKeyModelUsageDb.addUsage(batch.rows, batch.id),
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
      ReturnType<typeof virtualKeyModelUsageDb.getDayTotals>
    > = [];
    try {
      totals = await virtualKeyModelUsageDb.getDayTotals(date);
    } catch (e: any) {
      memoryLogger.warn(
        `虚拟密钥每日用量刷新失败(保留本进程计量): ${e?.message || e}`,
        "Quota",
      );
      return;
    }
    const byCell = new Map(
      totals.map((row) => [`${row.virtualKeyId}|${row.model}`, row] as const),
    );
    for (const [key, cell] of this.cells) {
      if (!key.startsWith(`${date}|`)) continue;
      const { virtualKeyId, model } = this.splitKey(key);
      const row = byCell.get(`${virtualKeyId}|${model}`);
      cell.dbTokens = row?.consumedTokens ?? 0;
      cell.dbRequests = row?.requestCount ?? 0;
      cell.loaded = true;
    }
  }

  /**
   * Reads the config table directly (not the fail-open cache) so a DB error
   * surfaces to the operator.
   */
  async snapshot(
    virtualKeyId: string,
    now: number = Date.now(),
  ): Promise<VirtualKeyQuotaEntry[]> {
    const rows = await virtualKeyModelQuotaDb.getByVirtualKeyId(virtualKeyId);
    const date = this.rollDay(now);
    const entries: VirtualKeyQuotaEntry[] = [];
    for (const row of rows) {
      if (!Number.isFinite(row.limitMillions) || row.limitMillions <= 0) {
        continue;
      }
      const cell = await this.ensureLoaded(date, virtualKeyId, row.model);
      entries.push({
        model: row.model,
        limitMillions: row.limitMillions,
        usedTokens: this.totalTokensOf(cell),
        requestCount: this.totalRequestsOf(cell),
      });
    }
    return entries.sort((a, b) => b.usedTokens - a.usedTokens);
  }

  async applyBulkQuotas(
    virtualKeyIds: string[],
    quotas: Array<{ model: string; limitMillions: number | null }>,
  ): Promise<void> {
    await virtualKeyModelQuotaDb.applyBulk(
      virtualKeyIds,
      quotas.map((entry) => ({
        model: entry.model,
        limitMillions: entry.limitMillions,
      })),
    );
    this.invalidateLimits();
  }

  /**
   * Follow a model rename: every key's ceiling must move with the model (a
   * lost ceiling would silently remove a limit) and so must today's counters
   * (or a rename would silently reset the budgets).
   */
  async renameModel(
    from: string,
    to: string,
    connection?: PoolConnection,
  ): Promise<() => void> {
    if (!from || !to || from === to) return () => {};
    const date = this.rollDay(Date.now());
    await virtualKeyModelQuotaDb.renameModel(from, to, connection);
    await virtualKeyModelUsageDb.renameDayUsage(date, from, to, connection);

    const commit = () => {
      this.invalidateLimits();
      for (const key of [...this.cells.keys()]) {
        const { date: cellDate, virtualKeyId, model } = this.splitKey(key);
        if (cellDate !== date || model !== from) continue;
        const fromKey = key;
        const toKey = this.cellKey(date, virtualKeyId, to);
        const source = this.cells.get(fromKey);
        if (!source) continue;
        const target = this.cells.get(toKey);
        if (target) {
          target.dbTokens += source.dbTokens;
          target.dbRequests += source.dbRequests;
          target.pendingTokens += source.pendingTokens;
          target.pendingRequests += source.pendingRequests;
          target.inFlightTokens += source.inFlightTokens;
          target.inFlightRequests += source.inFlightRequests;
        } else {
          // The DB row was merged (target + source) by renameDayUsage, so the
          // moved cell must re-read its baseline instead of trusting the
          // source-only total; pending/in-flight deltas are preserved.
          source.loaded = false;
          this.cells.set(toKey, source);
        }
        this.cells.delete(fromKey);
      }
      if (this.retryBatch) {
        for (const row of this.retryBatch.rows) {
          if (row.model === from) row.model = to;
        }
        for (const delta of this.retryBatch.sent) {
          const { date: cellDate, virtualKeyId, model } =
            this.splitKey(delta.key);
          if (cellDate === date && model === from) {
            delta.key = this.cellKey(date, virtualKeyId, to);
          }
        }
      }
    };
    if (connection) return commit;
    commit();
    return () => {};
  }

  resetForTesting(): void {
    this.cells.clear();
    this.limits = null;
    this.syncing = null;
    this.retryBatch = null;
    this.day = "";
    this.pruneDue = null;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

export const virtualKeyQuota = new VirtualKeyQuotaService();

/**
 * Callers must use the callback-style `done()` signature: an async hook would
 * leave the async-local scope before the handler runs.
 */
export function runWithQuotaContext<T>(fn: () => T): T {
  return quotaContext.run({}, fn);
}

export function stampQuotaModel(model: string | undefined): void {
  const store = quotaContext.getStore();
  if (store) store.model = model;
}

export function currentQuotaModel(): string | undefined {
  return quotaContext.getStore()?.model;
}
