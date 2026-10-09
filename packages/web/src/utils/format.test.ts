import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  formatPercentage,
  formatResponseTime,
  formatTimestamp,
  formatTokenNumber,
  formatUptime,
} from './format';

describe('formatNumber', () => {
  it('keeps sub-1000 numbers as-is without grouping', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(-5)).toBe('-5');
  });

  it('abbreviates thousands and millions identically through one branch', () => {
    expect(formatNumber(1000)).toBe('1.0K');
    expect(formatNumber(1234)).toBe('1.2K');
    expect(formatNumber(1_000_000)).toBe('1.0M');
    expect(formatNumber(2_500_000)).toBe('2.5M');
    expect(formatNumber(1_500_000_000)).toBe('1.5B');
  });

  it('honours decimals in the abbreviation branch', () => {
    expect(formatNumber(1234, { decimals: 2 })).toBe('1.23K');
    expect(formatNumber(1_234_567, { decimals: 0 })).toBe('1M');
  });

  it('applies grouping only below the abbreviation threshold', () => {
    expect(formatNumber(999, { useGrouping: true })).toBe('999');
    expect(formatNumber(999.6, { useGrouping: true })).toBe('1,000');
    expect(formatNumber(12345)).toBe('12.3K');
    expect(formatNumber(12345, { useGrouping: true })).toBe('12.3K');
  });
});

describe('formatTokenNumber', () => {
  it('formats small token counts with grouping', () => {
    expect(formatTokenNumber(0)).toBe('0');
    expect(formatTokenNumber(1234)).toBe('1,234');
    expect(formatTokenNumber(9999)).toBe('9,999');
  });

  it('abbreviates at K/M/B thresholds with two decimals', () => {
    expect(formatTokenNumber(10_000)).toBe('10.00K');
    expect(formatTokenNumber(1_500_000)).toBe('1.50M');
    expect(formatTokenNumber(1_500_000_000)).toBe('1.50B');
    expect(formatTokenNumber(1_500_000_000, { decimals: 1 })).toBe('1.5B');
  });
});

describe('formatPercentage', () => {
  it('short-circuits exact bounds and near-zero', () => {
    expect(formatPercentage(0)).toBe('0');
    expect(formatPercentage(100)).toBe('100');
    expect(formatPercentage(0.005)).toBe('0.00');
  });

  it('narrows precision as the value grows', () => {
    expect(formatPercentage(0.5)).toBe('0.50');
    expect(formatPercentage(5)).toBe('5.0');
    expect(formatPercentage(15)).toBe('15');
  });

  it('respects an explicit decimals override', () => {
    expect(formatPercentage(12.345, { decimals: 3 })).toBe('12.345');
    expect(formatPercentage(0.5, { decimals: 0 })).toBe('1');
  });
});

describe('formatResponseTime', () => {
  it('switches units and precision by magnitude', () => {
    expect(formatResponseTime(0.5)).toBe('0.500');
    expect(formatResponseTime(5)).toBe('5.00');
    expect(formatResponseTime(100)).toBe('100.0');
    expect(formatResponseTime(2000)).toBe('2.00');
  });

  it('respects an explicit decimals override', () => {
    expect(formatResponseTime(2000, { decimals: 1 })).toBe('2.0');
    expect(formatResponseTime(0.5, { decimals: 2 })).toBe('0.50');
  });
});

describe('formatTimestamp', () => {
  const ts = new Date(2024, 5, 25, 14, 30).getTime();

  it('returns empty string for missing or invalid input', () => {
    expect(formatTimestamp(0)).toBe('');
    expect(formatTimestamp(Number.NaN)).toBe('');
  });

  it('splits the zh-CN formatted string by period', () => {
    expect(formatTimestamp(ts, '24h')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatTimestamp(ts, '24h')).toBe('14:30');
    expect(formatTimestamp(ts, '7d')).toMatch(/^\d{2}\/\d{2}$/);
    expect(formatTimestamp(ts, '30d')).toBe(formatTimestamp(ts, '7d'));
  });
});

describe('formatUptime', () => {
  it('formats zero and sub-hour durations', () => {
    expect(formatUptime(0)).toBe('0s');
    expect(formatUptime(30)).toBe('0m');
    expect(formatUptime(90)).toBe('1m');
  });

  it('rolls up to hours and days', () => {
    expect(formatUptime(3600)).toBe('1h 0m');
    expect(formatUptime(3690)).toBe('1h 1m');
    expect(formatUptime(90_000)).toBe('1d 1h');
  });
});
