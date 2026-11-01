import type { VirtualKeyModelQuota, VirtualKeyQuotaPeriod, VirtualKeyQuotaUpsert } from '@/api/virtual-key';

/** Smallest expressible quota: 0.001 M = 1K tokens (matches the editor input's step).
 * Applies to every counting period — daily and weekly share the editor and the
 * server-side validation floor. */
export const VK_QUOTA_MIN_MILLIONS = 0.001;

export type VirtualKeyQuotaRowOp = 'set' | 'remove';

export interface VirtualKeyQuotaRowUsage {
  /** Tokens consumed in the row's counting period (day or natural week). */
  usedTokens: number;
  requestCount: number;
}

export interface VirtualKeyQuotaRow {
  model: string;
  op: VirtualKeyQuotaRowOp;
  /** Ceiling in millions; only read when op === 'set'. */
  limitMillions: number | null;
}

export type QuotaUpsertResult =
  | { ok: true; upserts: VirtualKeyQuotaUpsert[] }
  | { ok: false; reason: 'duplicate-model' | 'invalid-limit'; model: string };

export function createQuotaRow(op: VirtualKeyQuotaRowOp = 'set'): VirtualKeyQuotaRow {
  return { model: '', op, limitMillions: null };
}

/**
 * Editor rows -> bulk payload; blank-model rows are dropped. Duplicates are
 * rejected rather than merged: 'set' and 'remove' can both target one model
 * and last-write-wins is undefined server-side.
 */
export function buildQuotaUpserts(rows: VirtualKeyQuotaRow[]): QuotaUpsertResult {
  const upserts: VirtualKeyQuotaUpsert[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const model = (row.model ?? '').trim();
    if (!model) continue;
    if (seen.has(model)) return { ok: false, reason: 'duplicate-model', model };
    seen.add(model);
    if (row.op === 'remove') {
      upserts.push({ model, limitMillions: null });
      continue;
    }
    const limit = row.limitMillions;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < VK_QUOTA_MIN_MILLIONS) {
      return { ok: false, reason: 'invalid-limit', model };
    }
    upserts.push({ model, limitMillions: limit });
  }
  return { ok: true, upserts };
}

/**
 * Server quotas -> editor rows with usage attached. GET returns only configured
 * quotas; entries without a positive ceiling cannot be edited and are skipped.
 */
export function quotaRowsFromServer(
  quotas: VirtualKeyModelQuota[],
): Array<VirtualKeyQuotaRow & { usage: VirtualKeyQuotaRowUsage }> {
  return quotas
    .filter((quota) => typeof quota.limitMillions === 'number' && quota.limitMillions > 0)
    .map((quota) => ({
      model: quota.model,
      op: 'set' as const,
      limitMillions: quota.limitMillions,
      usage: { usedTokens: quota.usedTokens ?? 0, requestCount: quota.requestCount ?? 0 },
    }));
}

export type VirtualKeyQuotaHealthState = 'unconfigured' | 'active' | 'exhausted';

export interface VirtualKeyQuotaHealthDetail {
  model: string;
  period: VirtualKeyQuotaPeriod;
  usedTokens: number;
  limitTokens: number;
}

export interface VirtualKeyQuotaHealth {
  state: VirtualKeyQuotaHealthState;
  ratio: number;
  detail: VirtualKeyQuotaHealthDetail | null;
}

function healthRatio(detail: VirtualKeyQuotaHealthDetail): number {
  return detail.usedTokens / detail.limitTokens;
}

/**
 * Daily + weekly server quotas -> one aggregate health value. Entries without
 * a positive ceiling are ignored (weekly rows may carry a null limit); a key
 * with no configured quota in either window is `unconfigured`, any window at
 * or past its limit makes the whole key `exhausted`.
 */
export function deriveQuotaHealth(
  daily: VirtualKeyModelQuota[],
  weekly: VirtualKeyModelQuota[],
): VirtualKeyQuotaHealth {
  const candidates: VirtualKeyQuotaHealthDetail[] = [];
  const windows: Array<[VirtualKeyQuotaPeriod, VirtualKeyModelQuota[]]> = [
    ['daily', daily],
    ['weekly', weekly],
  ];
  for (const [period, quotas] of windows) {
    for (const quota of quotas) {
      const limitMillions = quota.limitMillions;
      if (typeof limitMillions !== 'number' || limitMillions <= 0) continue;
      candidates.push({
        model: quota.model,
        period,
        usedTokens: quota.usedTokens ?? 0,
        limitTokens: limitMillions * 1_000_000,
      });
    }
  }
  if (candidates.length === 0) return { state: 'unconfigured', ratio: 0, detail: null };

  let worst = candidates[0];
  let worstRatio = healthRatio(worst);
  let exhausted = worstRatio >= 1;
  for (const candidate of candidates.slice(1)) {
    const ratio = healthRatio(candidate);
    if (ratio > worstRatio) {
      worst = candidate;
      worstRatio = ratio;
    }
    exhausted = exhausted || ratio >= 1;
  }
  return { state: exhausted ? 'exhausted' : 'active', ratio: worstRatio, detail: worst };
}

const QUOTA_HEALTH_STOPS: Array<{ at: number; rgb: readonly [number, number, number] }> = [
  { at: 0, rgb: [24, 160, 88] },
  { at: 0.5, rgb: [240, 160, 32] },
  { at: 1, rgb: [208, 48, 80] },
];

/**
 * usage ratio -> hex color on the green-to-red ramp, clamped to [0, 1] so an
 * over-limit ratio stays at the terminal red instead of wrapping around.
 */
export function quotaHealthColor(ratio: number): string {
  const safe = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0;
  let lower = QUOTA_HEALTH_STOPS[0];
  let upper = QUOTA_HEALTH_STOPS[QUOTA_HEALTH_STOPS.length - 1];
  for (let i = 1; i < QUOTA_HEALTH_STOPS.length; i++) {
    if (safe <= QUOTA_HEALTH_STOPS[i].at) {
      lower = QUOTA_HEALTH_STOPS[i - 1];
      upper = QUOTA_HEALTH_STOPS[i];
      break;
    }
  }
  const t = upper.at === lower.at ? 0 : (safe - lower.at) / (upper.at - lower.at);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `#${hex(mix(lower.rgb[0], upper.rgb[0]))}${hex(mix(lower.rgb[1], upper.rgb[1]))}${hex(mix(lower.rgb[2], upper.rgb[2]))}`;
}
