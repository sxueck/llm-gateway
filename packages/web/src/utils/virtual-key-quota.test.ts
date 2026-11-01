import { describe, expect, it } from 'vitest';
import type { VirtualKeyModelQuota } from '@/api/virtual-key';
import {
  deriveQuotaHealth,
  quotaHealthColor,
} from '@/utils/virtual-key-quota';

function quota(partial: Partial<VirtualKeyModelQuota> & { model: string }): VirtualKeyModelQuota {
  return { limitMillions: 1, usedTokens: 0, requestCount: 0, ...partial };
}

describe('deriveQuotaHealth', () => {
  it('reports unconfigured when neither window has a positive ceiling', () => {
    expect(deriveQuotaHealth([], [])).toEqual({ state: 'unconfigured', ratio: 0, detail: null });
    // Weekly rows can carry a null limit: they must not count as configured.
    expect(
      deriveQuotaHealth([], [quota({ model: 'gpt', limitMillions: null, usedTokens: 5 })]),
    ).toEqual({ state: 'unconfigured', ratio: 0, detail: null });
  });

  it('aggregates both windows and surfaces the quota closest to its limit', () => {
    const health = deriveQuotaHealth(
      [quota({ model: 'a', limitMillions: 2, usedTokens: 1_000_000 })], // 0.5
      [quota({ model: 'b', limitMillions: 1, usedTokens: 900_000 })], // 0.9
    );
    expect(health.state).toBe('active');
    expect(health.ratio).toBeCloseTo(0.9);
    expect(health.detail).toEqual({
      model: 'b',
      period: 'weekly',
      usedTokens: 900_000,
      limitTokens: 1_000_000,
    });
  });

  it('marks the key exhausted when any single window reaches its limit', () => {
    const health = deriveQuotaHealth(
      [quota({ model: 'a', limitMillions: 1, usedTokens: 1_500_000 })],
      [quota({ model: 'b', limitMillions: 5, usedTokens: 100 })],
    );
    expect(health.state).toBe('exhausted');
    expect(health.ratio).toBeGreaterThanOrEqual(1);
    expect(health.detail?.model).toBe('a');
  });
});

describe('quotaHealthColor', () => {
  it('returns the terminal stops at the extremes and never wraps past 1', () => {
    expect(quotaHealthColor(0)).toBe('#18a058');
    expect(quotaHealthColor(1)).toBe('#d03050');
    expect(quotaHealthColor(4)).toBe('#d03050');
    expect(quotaHealthColor(-1)).toBe('#18a058');
    expect(quotaHealthColor(Number.NaN)).toBe('#18a058');
  });

  it('interpolates a valid hex color between stops', () => {
    const color = quotaHealthColor(0.5);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(color).toBe('#f0a020');
  });

});
