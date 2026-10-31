import type { VirtualKeyModelQuota, VirtualKeyQuotaUpsert } from '@/api/virtual-key';

/** Smallest expressible quota: 0.001 M = 1K tokens (matches the editor input's step). */
export const VK_QUOTA_MIN_MILLIONS = 0.001;

export type VirtualKeyQuotaRowOp = 'set' | 'remove';

export interface VirtualKeyQuotaRowUsage {
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
