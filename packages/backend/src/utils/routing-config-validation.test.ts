import { describe, it, expect } from 'vitest';

import { timePriorityRoutingConfigSchema, type TimePriorityRoutingConfig } from '@llm-gateway/shared';
import { validateRoutingConfigPayload } from './routing-config-validation.js';

function validConfig(): any {
  return {
    strategy: {
      mode: 'time_priority',
      timezone: 'Asia/Shanghai',
      time_rules: [
        { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', target_order: [0, 1] },
        { days: [1, 2, 3, 4, 5], start: '18:00', end: '24:00', target_order: [1, 0] },
      ],
    },
    targets: [
      { provider: 'provider-a', weight: 100 },
      { provider: 'provider-b', override_params: { model: 'gpt-4' } },
    ],
  };
}

describe('timePriorityRoutingConfigSchema', () => {
  it('accepts a valid config, including adjacent windows and a 24:00 tail', () => {
    const parsed = timePriorityRoutingConfigSchema.safeParse(validConfig());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const typed: TimePriorityRoutingConfig = parsed.data;
      expect(typed.strategy.time_rules).toHaveLength(2);
    }
  });

  it('accepts cross-midnight and multi-day night coverage without self overlap', () => {
    const config = validConfig();
    config.strategy.time_rules = [
      // 工作日夜间 22:00–次日 06:00（跨午夜，周五溢出到周六凌晨）。
      { days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00', target_order: [1, 0] },
      // 工作日白天与夜间规则相邻不重叠。
      { days: [1, 2, 3, 4, 5], start: '06:00', end: '22:00', target_order: [0, 1] },
    ];
    expect(timePriorityRoutingConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts well-known IANA zones including DST ones', () => {
    for (const timezone of ['UTC', 'America/New_York', 'Europe/Berlin']) {
      const config = validConfig();
      config.strategy.timezone = timezone;
      expect(timePriorityRoutingConfigSchema.safeParse(config).success).toBe(true);
    }
  });

  it('rejects an invalid or missing timezone', () => {
    const invalidZone = validConfig();
    invalidZone.strategy.timezone = 'Bogus/Zone';
    const invalid = timePriorityRoutingConfigSchema.safeParse(invalidZone);
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]!.message).toContain('IANA');
    }

    const missingZone = validConfig();
    delete missingZone.strategy.timezone;
    expect(timePriorityRoutingConfigSchema.safeParse(missingZone).success).toBe(false);
  });

  it('rejects overlapping windows on the same weekday', () => {
    const config = validConfig();
    config.strategy.time_rules = [
      { days: [1], start: '09:00', end: '12:00', target_order: [0, 1] },
      { days: [1], start: '11:00', end: '13:00', target_order: [1, 0] },
    ];
    const parsed = timePriorityRoutingConfigSchema.safeParse(config);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.message).toContain('时段重叠');
    }
  });

  it('rejects overlap caused by a cross-midnight rule spilling into the next weekday', () => {
    const config = validConfig();
    config.strategy.time_rules = [
      // 周一 22:00–周二 06:00 占用周二 [00:00, 06:00)。
      { days: [1], start: '22:00', end: '06:00', target_order: [1, 0] },
      // 周二 05:00 起与溢出部分相交。
      { days: [2], start: '05:00', end: '07:00', target_order: [0, 1] },
    ];
    expect(timePriorityRoutingConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects non-permutation target_order values', () => {
    const cases = [
      [0],        // 缺索引
      [0, 0],     // 重复
      [0, 2],     // 越界
      [1],        // 长度不足
      [0, 1, 1],  // 长度超出
    ];
    for (const target_order of cases) {
      const config = validConfig();
      config.strategy.time_rules = [
        { days: [1], start: '09:00', end: '18:00', target_order },
      ];
      const parsed = timePriorityRoutingConfigSchema.safeParse(config);
      expect(parsed.success, `target_order=${JSON.stringify(target_order)}`).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some(issue => issue.message.includes('全排列'))).toBe(true);
      }
    }
  });

  it('rejects malformed HH:mm values, equal start/end, and 24:00 as start', () => {
    const badTimes = [
      { start: '9:00', end: '18:00' },
      { start: '09:0', end: '18:00' },
      { start: '24:00', end: '24:00' },
      { start: '25:00', end: '26:00' },
      { start: '09:60', end: '10:00' },
      { start: '0900', end: '1800' },
    ];
    for (const { start, end } of badTimes) {
      const config = validConfig();
      config.strategy.time_rules = [{ days: [1], start, end, target_order: [0, 1] }];
      expect(timePriorityRoutingConfigSchema.safeParse(config).success, `start=${start}`).toBe(false);
    }

    const emptyWindow = validConfig();
    emptyWindow.strategy.time_rules = [{ days: [1], start: '09:00', end: '09:00', target_order: [0, 1] }];
    const parsed = timePriorityRoutingConfigSchema.safeParse(emptyWindow);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]!.message).toContain('不能相同');
    }
  });

  it('rejects invalid day lists', () => {
    for (const days of [[], [7], [1, 1], [0.5, 1]]) {
      const config = validConfig();
      config.strategy.time_rules = [{ days, start: '09:00', end: '18:00', target_order: [0, 1] }];
      expect(timePriorityRoutingConfigSchema.safeParse(config).success, `days=${JSON.stringify(days)}`).toBe(false);
    }
  });

  it('rejects empty time_rules, empty targets and unknown fields', () => {
    const noRules = validConfig();
    noRules.strategy.time_rules = [];
    expect(timePriorityRoutingConfigSchema.safeParse(noRules).success).toBe(false);

    const noTargets = validConfig();
    noTargets.targets = [];
    expect(timePriorityRoutingConfigSchema.safeParse(noTargets).success).toBe(false);

    // 未知字段（typo 防护）：strategy 与规则对象都按严格契约校验。
    const legacyStrategyKey = validConfig();
    legacyStrategyKey.strategy.affinityTTL = 60_000;
    expect(timePriorityRoutingConfigSchema.safeParse(legacyStrategyKey).success).toBe(false);

    const misspelledRuleKey = validConfig();
    misspelledRuleKey.strategy.time_rules = [
      { days: [1], start: '09:00', end: '18:00', targetOrder: [0, 1] },
    ];
    expect(timePriorityRoutingConfigSchema.safeParse(misspelledRuleKey).success).toBe(false);
  });
});

describe('validateRoutingConfigPayload', () => {
  it('returns null for non-time_priority configs without structural checks', () => {
    expect(validateRoutingConfigPayload('loadbalance', { strategy: { mode: 'loadbalance' }, targets: [] })).toBeNull();
    expect(validateRoutingConfigPayload('fallback', undefined)).toBeNull();
  });

  it('validates when body.type signals time_priority', () => {
    const issue = validateRoutingConfigPayload('time_priority', validConfig());
    expect(issue).toBeNull();

    const invalid = validConfig();
    invalid.strategy.time_rules = [
      { days: [1], start: '09:00', end: '12:00', target_order: [0, 1] },
      { days: [1], start: '10:00', end: '13:00', target_order: [1, 0] },
    ];
    const issue2 = validateRoutingConfigPayload('time_priority', invalid);
    expect(issue2?.message).toContain('时段重叠');
    expect(issue2?.param).toBe('config.strategy.time_rules.1');
  });

  it('validates when only config.strategy.mode signals time_priority (type column mismatch)', () => {
    const invalid = validConfig();
    invalid.strategy.time_rules[0].target_order = [0, 2];
    const issue = validateRoutingConfigPayload('fallback', invalid);
    expect(issue?.message).toContain('全排列');
    expect(issue?.param).toBe('config.strategy.time_rules.0.target_order');
  });

  it('rejects a time_priority type with no config at all', () => {
    const issue = validateRoutingConfigPayload('time_priority', undefined);
    expect(issue).not.toBeNull();
    expect(issue?.param).toBe('config');
  });
});
